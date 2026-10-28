"""Real LLM + an OWNED vanilla server, isolated from users' worlds.

Never an agent tool. Full private records remain under runtime/.
"""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import json
import shutil
import socket
import sys
import time
from datetime import datetime,timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from sim_agent.app.config import load_config
from sim_agent.adapters.mineflayer import ExecutorClient
from sim_agent.agents.coordinator import AgentTeam
from sim_agent.domain.goals import observation_inventory
from sim_agent.orchestration.task_runtime import TaskRuntime
from sim_agent.planning.model import DeepSeekClient
from sim_agent.observability.jsonl import RuntimeLogs
from live_acceptance import source_manifest


class OwnedLab:
    def __init__(self,output): self.output=output; self.proc=None; self.reader=None
    async def __aenter__(self):
        server=self.output/'server'; server.mkdir(parents=True,exist_ok=False)
        template=ROOT/'runtime/server'
        if 'eula=true' not in (template/'eula.txt').read_text(encoding='utf-8').lower():
            raise RuntimeError('Existing project lab must already accept EULA')
        shutil.copy2(template/'server.jar',server/'server.jar')
        shutil.copy2(template/'eula.txt',server/'eula.txt')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0)); self.port=sock.getsockname()[1]
        (server/'server.properties').write_text('\n'.join([
            'server-ip=127.0.0.1',f'server-port={self.port}','online-mode=false','enforce-secure-profile=false',
            'level-name=owned-acceptance-world','level-type=minecraft:flat','spawn-protection=0',
            'view-distance=3','simulation-distance=3','max-players=8','difficulty=peaceful',
            'enable-rcon=false','enable-query=false','motd=Owned hierarchical acceptance']),encoding='utf-8')
        java=(ROOT/'runtime/toolchain/java-path.txt').read_text(encoding='utf-8').strip()
        self.proc=await asyncio.create_subprocess_exec(java,'-Xms512M','-Xmx1536M','-jar','server.jar','nogui',cwd=server,
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.STDOUT)
        ready=asyncio.Event()
        async def consume():
            with (self.output/'server.log').open('w',encoding='utf-8') as log:
                while line:=await self.proc.stdout.readline():
                    text=line.decode('utf-8',errors='replace'); log.write(text); log.flush()
                    if 'Done (' in text: ready.set()
                ready.set()
        self.reader=asyncio.create_task(consume())
        try:
            await asyncio.wait_for(ready.wait(),90)
            if self.proc.returncode is not None: raise RuntimeError('Owned server startup failed')
        except BaseException:
            await self.__aexit__(None,None,None); raise
        return self
    async def commands(self,commands):
        self.proc.stdin.write(('\n'.join(commands)+'\n').encode('utf-8')); await self.proc.stdin.drain(); await asyncio.sleep(.4)
    async def reset(self):
        lines=(ROOT/'scripts/fixture_commands.txt').read_text(encoding='utf-8').splitlines()
        await self.commands([s for s in lines if s and not s.startswith('#')])
    async def __aexit__(self,*args):
        if self.proc and self.proc.returncode is None:
            self.proc.stdin.write(b'stop\n'); await self.proc.stdin.drain()
            try: await asyncio.wait_for(self.proc.wait(),30)
            except asyncio.TimeoutError: self.proc.terminate(); await self.proc.wait()
        if self.reader: await self.reader


CASES={
 'N01':'描述你所处的环境。',
 'N02':'不要移动，告诉我周围有哪些玩家，以及你背包里有什么。',
 'N05':'把那些东西放到那个箱子里。',
 'N06':'把那些东西放到那个箱子里。',
 'N07':'攻击旁边的僵尸。',
 'N09':'走到坐标(1,-60,2)，距离不超过1格，到达后告诉我。',
 'P01':'只用坐标(0,-60,-4)箱子里的两根橡木原木做成8块新橡木木板，放入坐标(8,-60,0)的箱子。目标箱必须新增8块，不准砍树，不消耗背包原有3块木板，并告诉我材料来源。',
 'P03':'保留背包原有3块橡木木板，额外制作4根木棍。可以采集附近原木补料，不能消耗保留木板。做好后告诉我。',
 'P05':'从坐标(0,-60,-4)箱子取两根橡木原木，如果那里没有，就从坐标(-4,-60,-4)箱子取。制作8块新木板放入坐标(8,-60,0)箱子，保留背包已有3块木板，不砍树，报告实际来源。',
 'P11':'只用坐标(0,-60,-4)箱子两根橡木原木制作8块新木板，放到坐标(8,-60,0)箱子，保留背包原有3块木板，不准砍树，最后报告。',
 'C01':'收集附近的原木并制作8块新木板，最后告诉我。',
}

async def run_case(lab,provider,case_id,directory):
    directory.mkdir(parents=True)
    profile=ROOT/f'config.{provider}.local.json'; original=load_config(profile)
    raw=json.loads(profile.read_text(encoding='utf-8'))
    name='H'+('DS' if provider=='deepseek' else 'SF')+case_id+str(int(time.time()))[-5:]
    raw['minecraft'].update(host='127.0.0.1',port=lab.port,username=name,world_id='owned-hierarchical-v1')
    raw['model'].update(key_file=str(original.model.key_file),max_tokens=4096,timeout_seconds=90,thinking=False,stream=True)
    raw['agent'].update(owner='*',max_steps=90,task_timeout_seconds=600,poll_seconds=.15)
    raw['learning']['mode']='B0'; raw['runtime_dir']=str(directory.resolve())
    raw['orchestration']={'mode':'hierarchical','max_model_calls':60}
    cfgpath=directory/'config.json'; cfgpath.write_text(json.dumps(raw),encoding='utf-8')
    config=load_config(cfgpath); logs=RuntimeLogs(directory); backend=ExecutorClient(config,logs)
    runtime=TaskRuntime(backend,AgentTeam(DeepSeekClient(config.model)),config,logs)
    case={'id':case_id,'provider':provider,'model':config.model.name,'thinking':False,'stream':True,
          'task':CASES[case_id],'passed':False,'budget':{'tools':90,'model_calls':60,'active_seconds':600},
          'status':'not_run'}
    started=time.monotonic()
    try:
        await lab.reset()
        if case_id=='P05': await lab.commands(['item replace block 0 -60 -4 container.0 with minecraft:air'])
        await backend.start()
        await lab.commands([f'tp {name} 0 -60 0',f'clear {name}',f'give {name} minecraft:oak_planks 3'])
        await asyncio.sleep(.5)
        before=await backend.request('observe',{})
        async def count(pos,item):
            c=await backend.request('inspect_container',{'position':pos},timeout=25)
            return sum(i['count'] for i in c['items'] if i['name']==item)
        source={'x':0,'y':-60,'z':-4}; target={'x':8,'y':-60,'z':0}; alt={'x':-4,'y':-60,'z':-4}; other={'x':10,'y':-60,'z':0}
        if case_id in {'P01','P05','P11'}:
            baselines={'source':await count(source,'minecraft:oak_log'),'target':await count(target,'minecraft:oak_planks'),
                       'alt':await count(alt,'minecraft:oak_log'),'other':await count(other,'minecraft:oak_planks')}
        task=asyncio.create_task(runtime.run(CASES[case_id],requested_by='AcceptancePlayer',raw_chat='!agent '+CASES[case_id]))
        if case_id=='C01':
            async with asyncio.timeout(10):
                while runtime.budget is None or runtime.budget.calls==0: await asyncio.sleep(.02)
            await asyncio.sleep(.15); await runtime.cancel('第三位玩家停止任务')
        if case_id=='P11':
            async with asyncio.timeout(400):
                while not any(s.op=='act' and s.args.get('kind')=='craft' and s.status=='succeeded' for s in (runtime.state.steps if runtime.state else [])):
                    if task.done(): break
                    await asyncio.sleep(.02)
            if not task.done():
                await runtime.cancel('第二位玩家纠正任务')
                first=await task
                task=asyncio.create_task(runtime.run('改放坐标(10,-60,0)箱子，其他要求不变',requested_by='SecondPlayer',
                    continuation_context={'previous_root_task_id':first.root_task_id,'correction':'改放坐标(10,-60,0)箱子，其他要求不变'}))
        outcome=await task
        if case_id=='N06' and outcome.end_state=='needs_clarification':
            outcome=await runtime.run('背包中的2块橡木木板，放到坐标(8,-60,0)箱子，不需要制作。',requested_by='SecondPlayer',
                continuation_context={'previous_root_task_id':outcome.root_task_id,'answer':'背包中的2块橡木木板，放到坐标(8,-60,0)箱子，不需要制作。'})
        case['outcome']=outcome.to_dict()
        after=await backend.request('observe',{}); inv=observation_inventory(after)
        mutations=[s for s in outcome.steps if s['op']=='act']
        checks={}; proof={'inventory':inv,'position':after['position'],'actual_actions':[s['args'] for s in mutations]}
        if case_id in {'N01','N02'}:
            checks={'completed':outcome.completed,'submitted':outcome.delivery_status=='submitted','no_mutations':not mutations,
                    'no_fake_goal':bool(runtime.snap.get('contract')) and not any(c['kind']=='state_predicate' for c in TaskContract(runtime.snap['contract']).checks)}
        elif case_id=='N05': checks={'clarifies':outcome.end_state=='needs_clarification','no_mutations':not mutations,'no_inspections':not any(s['op']=='inspect_container' for s in outcome.steps)}
        elif case_id=='N06': checks={'completed':outcome.completed,'remaining_planks':inv.get('minecraft:oak_planks',0)==1,'target':await count(target,'minecraft:oak_planks')==7}
        elif case_id=='N07': checks={'unsupported':outcome.end_state=='failed','no_mutations':not mutations}
        elif case_id=='N09': checks={'completed':outcome.completed,'distance':sum((after['position'][a]-v)**2 for a,v in zip(('x','y','z'),(1,-60,2)))<=1.00001}
        elif case_id in {'P01','P05','P11'}:
            now={'source':await count(source,'minecraft:oak_log'),'target':await count(target,'minecraft:oak_planks'),
                 'alt':await count(alt,'minecraft:oak_log'),'other':await count(other,'minecraft:oak_planks')}
            proof.update(before=baselines,after=now)
            dest='other' if case_id=='P11' else 'target'; src='alt' if case_id=='P05' else 'source'
            checks={'completed':outcome.completed,'source_delta':now[src]-baselines[src]==-2,
                    'target_delta':now[dest]-baselines[dest]==8,'preserved_planks':inv.get('minecraft:oak_planks',0)==3,
                    'no_logs_left':inv.get('minecraft:oak_log',0)==0,'no_collect':not any(s['args']['kind']=='collect' for s in mutations)}
            if case_id=='P11': checks['no_duplicate_craft']=sum(s['args']['kind']=='craft' for s in mutations)==1
        elif case_id=='P03': checks={'completed':outcome.completed,'new_sticks':inv.get('minecraft:stick',0)>=4,'reserved_planks':inv.get('minecraft:oak_planks',0)>=3}
        elif case_id=='C01': checks={'cancelled':outcome.end_state=='cancelled','no_mutations':not mutations}
        case.update(passed=all(checks.values()),status='finished',checks=checks,proof=proof,outcome=outcome.to_dict())
    except Exception as e:
        case.update(status='error',error_type=type(e).__name__,error=str(e)[:300])
    finally:
        if runtime.active: await runtime.cancel('验收清理')
        await backend.shutdown(); runtime.store.close(); logs.close()
        case['duration_seconds']=round(time.monotonic()-started,2)
        (directory/'result.json').write_text(json.dumps(case,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'provider':provider,'case':case_id,'passed':case['passed'],'status':case['status'],
                      'end_state':case.get('outcome',{}).get('end_state'),'error':case.get('error')},ensure_ascii=False),flush=True)
    return case


async def main_async(args):
    output=args.output or ROOT/'runtime/hierarchical-acceptance'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
    output.mkdir(parents=True,exist_ok=False); before=source_manifest(); results=[]
    async with OwnedLab(output) as lab:
        for provider in args.providers:
            for case_id in args.cases:
                print(f'START {provider} {case_id}',flush=True)
                results.append(await run_case(lab,provider,case_id,output/provider/case_id))
    unchanged=source_manifest()==before
    report={'environment':'LIVE_OWNED_VANILLA_1.21.1','cloud_llm_tested':True,'rules_fallback':False,
            'source_unchanged':unchanged,'source_manifest':before,'cases':results,
            'passed':unchanged and all(c['passed'] for c in results)}
    (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'output':str(output),'passed':report['passed']},ensure_ascii=False),flush=True)
    return 0 if report['passed'] else 1


if __name__=='__main__':
    from sim_agent.domain.contracts import TaskContract
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--providers',nargs='+',choices=['deepseek','siliconflow'],default=['deepseek','siliconflow'])
    p.add_argument('--cases',nargs='+',choices=list(CASES),default=list(CASES))
    p.add_argument('--output',type=Path)
    raise SystemExit(asyncio.run(main_async(p.parse_args())))
