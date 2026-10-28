"""Zero-model action debugging reuses the real controller with a fake backend."""
import asyncio
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sim_agent.domain.debug_command import parse_debug_command
from sim_agent.domain.errors import ValidationError, ConfigError
from sim_agent.app.config import load_config
from sim_agent.app.cli import build_parser, _run
from sim_agent.execution.action_debug import ActionDebugRunner
from sim_agent.execution.service import AgentService
from test_planner import make_config, FakeBackend, observation, wait_until


class CommandTests(unittest.TestCase):
    def test_supported_commands_are_complete_and_normalized(self):
        for text in ['collect oak_log 4','collect minecraft:oak_log 4','采集4个橡木原木']:
            c=parse_debug_command(text)
            self.assertEqual(c.call.args,{'kind':'collect','block':'minecraft:oak_log','count':4})
            self.assertEqual(c.goal.spec['type'],'inventory_increase')
        self.assertEqual(parse_debug_command('goto 10 -60 5').call.args['position'],{'x':10,'y':-60,'z':5})
        self.assertIsNone(parse_debug_command('停止').call)

    def test_extra_intent_ambiguity_negation_and_invalid_values_are_rejected(self):
        for text in ['采集4个原木','采集4个橡木原木然后全部扔掉','不要采集，去看看树',
                     'collect oak_log 4 不要移动','goto 1 2 3 and collect oak_log 4',
                     'collect stone 4','collect oak_log 0','collect oak_log 65','goto nan 2 3','goto 1 2',
                     'collect oak_log -1','采集四个橡木原木','craft stick 4']:
            with self.subTest(text=text),self.assertRaises(ValidationError):parse_debug_command(text)

    def test_configuration_does_not_require_or_validate_model_for_explicit_debug(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw=json.loads(Path('config.example.json').read_text(encoding='utf-8'))
            raw.pop('model');p=Path(tmp)/'debug.local.json';p.write_text(json.dumps(raw),encoding='utf-8')
            with self.assertRaises(ConfigError):load_config(p)
            cfg=load_config(p,action_debug=True)
            self.assertEqual(cfg.learning.mode,'B0')
            self.assertEqual(cfg.model.name,'disabled')


class EvidenceBackend(FakeBackend):
    mined=4
    async def request(self,op,args,timeout=None):
        result=await super().request(op,args,timeout)
        if op=='action_status' and result.get('status')=='succeeded':result['effect']={'mined_count':self.mined}
        return result


class DebugTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.config=make_config(Path(self.tmp.name),task_timeout=5)

    async def asyncTearDown(self):self.tmp.cleanup()

    async def test_collect_requires_new_inventory_and_mining_evidence(self):
        backend=EvidenceBackend([observation({'minecraft:oak_log':10}),observation({'minecraft:oak_log':14})])
        result=await ActionDebugRunner(backend,self.config).run('collect oak_log 4')
        self.assertEqual(result.end_state,'completed',result.message)
        self.assertEqual(result.usage['model_calls'],0)
        self.assertEqual(backend.act_calls,1)
        self.assertIn('+4',result.message)

    async def test_existing_stock_partial_gain_and_unrelated_items_do_not_complete(self):
        for items in [{'minecraft:oak_log':10},{'minecraft:oak_log':12},{'minecraft:oak_log':10,'minecraft:dirt':4}]:
            backend=EvidenceBackend([observation({'minecraft:oak_log':10}),observation(items)])
            result=await ActionDebugRunner(backend,self.config).run('collect oak_log 4')
            self.assertEqual(result.end_state,'failed')
            self.assertEqual(backend.act_calls,1)

    async def test_missing_or_insufficient_action_evidence_does_not_complete(self):
        for mined in [0,2,None]:
            backend=EvidenceBackend([observation(),observation({'minecraft:oak_log':4})]);backend.mined=mined
            result=await ActionDebugRunner(backend,self.config).run('collect oak_log 4')
            self.assertEqual(result.end_state,'failed')

    async def test_goto_checks_fresh_position(self):
        for x,status in [(10,'completed'),(0,'failed')]:
            backend=FakeBackend([observation(),observation(x=x,z=5)])
            result=await ActionDebugRunner(backend,self.config).run('goto 10 64 5')
            self.assertEqual(result.end_state,status,result.message)
            self.assertEqual(backend.act_calls,1)

    async def test_invalid_input_has_no_backend_side_effect(self):
        backend=FakeBackend([observation()])
        result=await ActionDebugRunner(backend,self.config).run('采集4个橡木原木然后制作木镐')
        self.assertEqual(result.end_state,'needs_clarification')
        self.assertEqual(backend.calls,[])

    async def test_stop_unknown_effect_blocks_next_action(self):
        backend=FakeBackend([observation()],action_statuses=['running'])
        runner=ActionDebugRunner(backend,self.config)
        task=asyncio.create_task(runner.run('collect oak_log 4'))
        await wait_until(lambda:backend.act_calls==1)
        await runner.cancel('本地测试停止')
        result=await task
        self.assertEqual(result.end_state,'interrupted')
        self.assertTrue(result.recovery_required)
        second=await runner.run('goto 1 64 2')
        self.assertEqual(second.end_state,'interrupted')
        self.assertEqual(backend.act_calls,1)

    async def test_cli_path_never_constructs_planners_model_or_memory(self):
        backend=FakeBackend([observation(),observation(x=1,z=2)])
        args=build_parser().parse_args(['--action-debug','--task','goto 1 64 2'])
        with patch('sim_agent.app.cli.ExecutorClient',return_value=backend), \
             patch('sim_agent.app.cli.DeepSeekClient',side_effect=AssertionError('model forbidden')), \
             patch('sim_agent.app.cli.LLMPlanner',side_effect=AssertionError('planner forbidden')), \
             patch('sim_agent.app.cli.RulePlanner',side_effect=AssertionError('planner forbidden')), \
             patch('sim_agent.app.cli.ExperienceStore',side_effect=AssertionError('memory forbidden')), \
             patch('sim_agent.execution.service.TaskRunner',side_effect=AssertionError('legacy runner forbidden')), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(await _run(args,self.config,None),0)
        self.assertEqual(backend.act_calls,1)

    async def test_shared_chat_authorization_busy_and_fast_stop(self):
        backend=FakeBackend([observation()],action_statuses=['running'])
        service=AgentService(backend,None,self.config,emit=lambda _:None,chat_progress=False,action_debug=True)
        async def say(*args,**kwargs):return True
        service._say=say
        try:
            owner=self.config.agent.owner
            self.assertEqual(await service.handle_chat('Other','!agent collect oak_log 4'),'unauthorized')
            self.assertEqual(await service.handle_chat(owner,'!agent collect oak_log 4'),'started')
            await wait_until(lambda:backend.act_calls==1)
            self.assertEqual(await service.handle_chat(owner,'!agent goto 1 64 2'),'busy')
            self.assertEqual(await service.handle_chat(owner,'!agent 停止'),'cancelled')
            await service._wait_current(3)
            self.assertEqual(backend.act_calls,1)
        finally:await service.shutdown()
