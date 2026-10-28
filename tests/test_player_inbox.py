"""Live-message scheduling tests: scripted models and backend only."""
import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path
from dataclasses import replace

import test_hierarchical as h
from test_business_roles import business_contract, stage
from test_planner import make_config, observation, FakeBackend, wait_until
from sim_agent.agents.coordinator import AgentTeam
from sim_agent.app.config import OrchestrationConfig
from sim_agent.execution.service import AgentService
from sim_agent.orchestration.task_runtime import TaskRuntime
from sim_agent.planning.model import ModelResult


class ConcurrentTeam(AgentTeam):
    is_real_model=False

    def __init__(self, decisions):
        self.controls=list(decisions); self.calls=[]; self.started=asyncio.Event()
        self.release=asyncio.Event(); self.control_started=asyncio.Event(); self.control_release=None
        self.roots=0

    async def call(self,role,context,timeout,observer):
        self.calls.append((role,copy.deepcopy(context)))
        if context.get('purpose')=='player_message':
            self.control_started.set()
            if self.control_release: await self.control_release.wait()
            value=self.controls.pop(0)
            if callable(value): value=value(context)
        elif role=='worker':
            self.started.set(); await self.release.wait()
            value=h.proposal('worker','blocked',category='test',explanation='本地测试阻塞',attempted_evidence_ids=[],needed_information='材料')
        elif not context.get('contract'):
            self.roots+=1; text=context['original_request']['command_text']
            value=h.proposal('coordinator','delegate',contract_draft=business_contract(text),stage=stage(text))
        else:
            value=h.proposal('coordinator','cannot_complete',reason_code='blocked',explanation='本地测试结束',unmet_requirements=['r1'])
        return ModelResult(json.dumps(value,ensure_ascii=False),{'total_tokens':10},'SCRIPTED')


class InboxTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.service=None
        base=make_config(Path(self.tmp.name),max_steps=40,task_timeout=30)
        self.config=replace(base,orchestration=OrchestrationConfig(mode='hierarchical'),agent=replace(base.agent,owner='*'))
        self.backend=FakeBackend([observation()])

    async def asyncTearDown(self):
        if self.service: await self.service.shutdown()
        self.tmp.cleanup()

    async def start(self,team):
        s=self.service=AgentService(self.backend,team,self.config,emit=lambda _:None,chat_progress=False)
        # Avoid chat throttling in isolated tests.
        async def say(text,**kwargs):
            await self.backend.request('say',{'message':text}); return True
        s._say=say
        self.assertEqual(await s.handle_chat('A','!agent 收集木材'),'started')
        await asyncio.wait_for(team.started.wait(),2)
        return s

    async def control_done(self,s):
        await wait_until(lambda: s._inbox.job is not None and s._inbox.job.done())

    async def test_question_is_answered_while_worker_keeps_running(self):
        team=ConcurrentTeam([lambda c:h.proposal('coordinator','reply',text='正在处理采集任务，尚未完成。',evidence_refs=[c['evidence'][-1]['id']])])
        s=await self.start(team); root=s.runner.snap['root_task_id']
        self.assertEqual(await s.handle_chat('B','!agent 你在做什么？'),'received')
        await self.control_done(s)
        self.assertTrue(s.busy); self.assertEqual(s.runner.snap['root_task_id'],root)
        self.assertIn('正在处理采集任务，尚未完成。',self.backend.say_calls)
        self.assertEqual(self.backend.stop_calls,0)

    async def test_new_task_is_queued_then_started_without_body_overlap(self):
        team=ConcurrentTeam([h.proposal('coordinator','queue')]); s=await self.start(team)
        await s.handle_chat('B','!agent 描述环境'); await self.control_done(s)
        self.assertEqual(team.roots,1)
        self.assertEqual(s._inbox.waiting[0],('B','!agent 描述环境','描述环境'))
        team.release.set()
        await wait_until(lambda:team.roots==2)
        await wait_until(lambda:not s.busy)
        self.assertEqual(self.backend.act_calls,0)

    async def test_replacement_waits_for_old_task_and_preserves_requester(self):
        team=ConcurrentTeam([h.proposal('coordinator','replace')]); s=await self.start(team)
        first=s.runner.snap['root_task_id']
        await s.handle_chat('B','!agent 现在过来'); await self.control_done(s)
        await wait_until(lambda:team.roots==2)
        self.assertNotEqual(s.runner.snap['root_task_id'],first)
        self.assertEqual(s.runner.snap['request']['raw_chat'],'!agent 现在过来')
        self.assertEqual(s.runner.snap['request']['requester'],'B')
        self.assertGreater(self.backend.stop_calls,0)

    async def test_stop_discards_inflight_supervision_and_queued_tasks(self):
        team=ConcurrentTeam([h.proposal('coordinator','replace')]); team.control_release=asyncio.Event()
        s=await self.start(team)
        await s.handle_chat('B','!agent 过来')
        await team.control_started.wait()
        self.assertEqual(await s.handle_chat('C','!agent 停止'),'cancelled')
        team.control_release.set()
        await wait_until(lambda:not s.busy)
        await self.control_done(s)
        self.assertEqual(team.roots,1); self.assertEqual(self.backend.act_calls,0)

    async def test_pause_preserves_root_and_resume_uses_same_root(self):
        team=ConcurrentTeam([h.proposal('coordinator','pause'),h.proposal('coordinator','resume')]); s=await self.start(team)
        root=s.runner.snap['root_task_id']
        await s.handle_chat('B','!agent 先暂停'); await self.control_done(s)
        self.assertFalse(s.busy); self.assertEqual(s.runner.snap['status'],'interrupted')
        await s.handle_chat('B','!agent 恢复刚才的任务'); await self.control_done(s)
        await wait_until(lambda:s.runner.active or not s.busy)
        self.assertEqual(s.runner.snap['root_task_id'],root)

    async def test_cancel_only_worker_preserves_root_and_returns_control(self):
        team=ConcurrentTeam([h.proposal('coordinator','cancel_stage')]); s=await self.start(team)
        root=s.runner.snap['root_task_id']
        await s.handle_chat('B','!agent 停下这个子任务，重新考虑'); await self.control_done(s)
        await wait_until(lambda:not s.busy)
        self.assertEqual(s.runner.snap['root_task_id'],root)
        self.assertEqual(s.runner.snap['stages'][0]['status'],'blocked')
        self.assertNotEqual(s._last_outcome.end_state,'cancelled')
        self.assertEqual(self.backend.act_calls,0)

    async def test_unauthorized_message_does_not_trigger_coordinator(self):
        team=ConcurrentTeam([]); s=await self.start(team)
        s._config=replace(s._config,agent=replace(s._config.agent,owner='A'))
        self.assertEqual(await s.handle_chat('B','!agent 过来'),'unauthorized')
        self.assertFalse(team.control_started.is_set())

    async def test_unknown_old_action_prevents_automatic_replacement(self):
        team=ConcurrentTeam([h.proposal('coordinator','replace')]); s=await self.start(team)
        root=s.runner.snap['root_task_id']
        s.runner.store.journal(root,s.runner.session_id,{'status':'unknown','op':'act','args':{'kind':'craft'}})
        await s.handle_chat('B','!agent 过来'); await self.control_done(s)
        self.assertEqual(team.roots,1)
        self.assertEqual(s.runner.snap['root_task_id'],root)
        self.assertEqual(s.runner.snap['status'],'interrupted')

    async def test_identical_preparation_is_idempotent(self):
        team=ConcurrentTeam([]); s=await self.start(team)
        runtime=s.runner; current=runtime.stage
        checks=h.contract('收集木材')['deliverables'][0]['acceptance_checks']
        stage_checks=[{'kind':'evidence_requirement','evidence_kind':'observe','selectors':[],'requirement_ids':['r1']}]
        payload={'deliverables':[{'id':'d1','acceptance_checks':checks}],'stage_checks':stage_checks}
        scoped=copy.deepcopy(runtime.state)
        await runtime._prepare_verification(payload,scoped)
        await runtime._prepare_verification(payload,scoped)
        self.assertTrue(runtime.snap['contract']['deliverables'][0]['acceptance_checks'])
        self.assertEqual(current['acceptance_checks'],stage_checks)


class FastPathTests(unittest.IsolatedAsyncioTestCase):
    async def test_factual_question_uses_one_coordinator_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            config=replace(make_config(Path(tmp)),orchestration=OrchestrationConfig(mode='hierarchical'))
            def answer(c):
                report=h.report({'evidence':[{'id':c['evidence'][-1]['id'],'kind':'observe','payload':c['observation']}]})['payload']['report']
                return h.proposal('coordinator','answer',report=report)
            team=h.ScriptedTeam([answer]);team.protocol_version='business.v2'
            runtime=TaskRuntime(FakeBackend([observation()]),team,config);runtime.delivery.interval=0
            try:
                outcome=await runtime.run('描述环境')
                self.assertEqual(outcome.end_state,'completed',outcome.message)
                self.assertEqual([r for r,_ in team.calls],['coordinator'])
            finally:runtime.store.close()

    async def test_simple_action_delegates_and_prepares_in_same_worker_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            config=replace(make_config(Path(tmp),max_steps=20),orchestration=OrchestrationConfig(mode='hierarchical'))
            task='去坐标1 64 2'; goal={'type':'near_position','position':{'x':1,'y':64,'z':2},'range':1}
            checks=h.contract(task,goal)['deliverables'][0]['acceptance_checks']
            team=h.ScriptedTeam([h.proposal('coordinator','delegate',contract_draft=business_contract(task),stage=stage(task)),
                lambda c:h.report({'evidence':[{'id':c['evidence'][-1]['id'],'kind':'observe','payload':c['observation']}]})],
                [h.proposal('worker','act',kind='goto',args={'position':goal['position'],'range':1},purpose='到达',
                    verification={'deliverables':[{'id':'d1','acceptance_checks':checks}],'stage_checks':checks[:1]}),
                 h.proposal('worker','submit_result',summary='请求验证',evidence_ids=[],output_refs=[],unresolved_items=[])])
            team.protocol_version='business.v2'
            backend=FakeBackend([observation(),observation(x=1,z=2)])
            runtime=TaskRuntime(backend,team,config);runtime.delivery.interval=0
            try:
                outcome=await runtime.run(task)
                self.assertEqual(outcome.end_state,'completed',outcome.message)
                self.assertEqual(backend.act_calls,1)
                self.assertEqual(len(team.calls),4)
            finally:runtime.store.close()
