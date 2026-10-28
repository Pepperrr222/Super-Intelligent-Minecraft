"""Clarification/correction continuation across pending states; no API calls."""
import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path
from dataclasses import replace

from sim_agent.agents.coordinator import AgentTeam
from sim_agent.app.config import OrchestrationConfig
from sim_agent.execution.service import AgentService
from sim_agent.planning.model import ModelResult
from test_planner import make_config, FakeBackend, observation, wait_until
from test_hierarchical import proposal


class ClarifyingTeam(AgentTeam):
    is_real_model=False

    def __init__(self): self.calls=[]

    async def call(self,role,context,timeout,observer):
        self.calls.append((role,copy.deepcopy(context)))
        if context.get('purpose')=='player_message':
            value=proposal('coordinator','correct')
        else:
            value=proposal('coordinator','clarify',question='工具放在哪里？',missing_fields=['交付方式'])
        return ModelResult(json.dumps(value,ensure_ascii=False),{'total_tokens':10},'SCRIPTED')


class PendingInputTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.service=None
        base=make_config(Path(self.tmp.name),max_steps=40,task_timeout=30)
        self.config=replace(base,orchestration=OrchestrationConfig(mode='hierarchical'),agent=replace(base.agent,owner='*'))
        self.backend=FakeBackend([observation()]);self.team=ClarifyingTeam()

    async def asyncTearDown(self):
        if self.service: await self.service.shutdown()
        self.tmp.cleanup()

    def create(self):
        self.service=AgentService(self.backend,self.team,self.config,emit=lambda _:None,chat_progress=False)
        async def say(text,**kwargs):
            await self.backend.request('say',{'message':text});return True
        self.service._say=say
        return self.service

    async def waiting(self):
        s=self.create()
        await s.handle_chat('A','!agent 做木工具，不要移动')
        await s._wait_current(3)
        self.assertEqual(s.runner.snap['status'],'waiting_input')
        return s

    async def test_natural_supplement_explicit_answer_and_correction_share_root(self):
        s=await self.waiting(); root=s.runner.snap['root_task_id']
        for index,(message,expected_type) in enumerate([
            ('!agent 放在箱子里，自己做箱子','clarification'),
            ('!agent 回答 五种工具各一件','clarification'),
            ('!agent 纠正 改成只做木镐','correction')],1):
            previous_question=s.runner.snap['question']['id']
            await s.handle_chat('B',message)
            if s._inbox.job: await asyncio.wait_for(s._inbox.job,3)
            await s._wait_current(3)
            snap=s.runner.snap
            self.assertEqual(snap['root_task_id'],root)
            self.assertEqual(snap['request']['raw_chat'],'!agent 做木工具，不要移动')
            self.assertEqual(len(snap['request']['amendments']),index)
            amendment=snap['request']['amendments'][-1]
            self.assertEqual(amendment['type'],expected_type)
            self.assertEqual(amendment['author'],'B')
            self.assertEqual(amendment['raw_chat'],message)
            self.assertEqual(amendment['question_id'],previous_question)
            self.assertTrue(s.runner.state.constraints['no_move'])
        self.assertEqual(self.backend.act_calls,0)
        self.assertEqual(self.backend.stop_calls,0)

    async def test_pending_input_is_available_to_coordinator_after_restart(self):
        s=await self.waiting();root=s.runner.snap['root_task_id']
        before=s.runner.snap['budget']['calls']
        await s.shutdown();self.service=None
        s=self.create()
        self.assertIsNone(s.runner.snap)
        self.assertEqual(await s.handle_chat('B','!agent 用旁边的材料就可以'),'received')
        await asyncio.wait_for(s._inbox.job,3);await s._wait_current(3)
        control=next(ctx for _,ctx in reversed(self.team.calls) if ctx.get('purpose')=='player_message')
        self.assertEqual(control['current_task']['question']['text'],'工具放在哪里？')
        self.assertEqual(s.runner.snap['root_task_id'],root)
        self.assertEqual(s.runner.snap['request']['amendments'][-1]['text'],'用旁边的材料就可以')
        self.assertGreater(s.runner.snap['budget']['calls'],before)
        self.assertTrue(s.runner.state.constraints['no_move'])

    async def test_stopped_question_cannot_be_revived_by_answer_or_correction(self):
        s=await self.waiting();root=s.runner.snap['root_task_id']
        await s.handle_chat('B','!agent 停止')
        calls=len(self.team.calls)
        self.assertEqual(await s.handle_chat('B','!agent 回答 放箱子里'),'idle')
        self.assertEqual(await s.handle_chat('B','!agent 纠正 改成木镐'),'idle')
        self.assertEqual(len(self.team.calls),calls)
        self.assertEqual(s.runner.store.read_task(root)['status'],'cancelled')

    async def test_paused_root_accepts_supplement_without_resetting_progress(self):
        s=await self.waiting();root=s.runner.snap['root_task_id']
        saved=s.runner.store.read_task(root)
        saved['status']='interrupted'
        saved['progress']=[{'stage':'prior','summary':'既有测试进展','evidence_ids':[]}]
        s.runner.store.commit_transition(saved['revision'],{'type':'test_pause'},saved)
        await s.handle_chat('B','!agent 只用已有材料，不采集')
        await asyncio.wait_for(s._inbox.job,3);await s._wait_current(3)
        self.assertEqual(s.runner.snap['root_task_id'],root)
        self.assertEqual(s.runner.snap['progress'][0]['stage'],'prior')
        self.assertEqual(s.runner.snap['request']['amendments'][-1]['type'],'clarification')
        self.assertTrue(s.runner.state.constraints['no_move'])
        self.assertTrue(s.runner.state.constraints['no_collect'])
        self.assertEqual(self.backend.stop_calls,0)
