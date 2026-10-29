"""Small personal-test runner: disposable vanilla world -> Agent -> checks -> JSON/CSV."""
import asyncio
from dataclasses import replace
from datetime import datetime
import csv
import json
from pathlib import Path
import secrets
import time
from .setup import ROOT,BENCH
from .environment import OwnedServer,fixture_commands,PUBLIC_SCENE,atomic_json
from .grader import grade
from sim_agent.app.config import load_config
from sim_agent.adapters.mineflayer import ExecutorClient
from sim_agent.agents.coordinator import AgentTeam
from sim_agent.domain.errors import DeadlineExceeded
from sim_agent.execution.service import AgentService
from sim_agent.memory.store import ExperienceStore
from sim_agent.observability.jsonl import RuntimeLogs
from sim_agent.planning.model import DeepSeekClient
from sim_agent.planning.planner import LLMPlanner
from sim_agent.planning.rules import RulePlanner

class CountedModel:
    def __init__(self,client,limit):self.client=client;self.limit=limit;self.calls=0
    async def complete(self,*args,**kwargs):
        if self.calls>=self.limit:raise DeadlineExceeded("benchmark模型调用预算耗尽")
        self.calls+=1;return await self.client.complete(*args,**kwargs)
    async def complete_observed(self,messages,timeout,observer):
        if self.calls>=self.limit:raise DeadlineExceeded("benchmark模型调用预算耗尽")
        self.calls+=1
        return await self.client.complete_observed(messages,timeout,observer)

async def episode(task,args,directory):
    directory.mkdir(parents=True,exist_ok=False)
    result={"task_id":task["id"],"title":task["title"],"episode_status":"invalid","success":None,
        "mode":args.orchestration+"/"+args.planner,"budget":task["budget"],"predicate_results":[],"invalid_reason":None}
    service=None;logs=None;memory=None;pending=None;started=time.monotonic()
    try:
        async with OwnedServer(directory/"server",args.java,args.accept_eula) as server:
            await server.commands(fixture_commands(task["id"]))
            original=load_config(args.config.resolve());username="Bench"+secrets.token_hex(4)
            mc=replace(original.minecraft,host="127.0.0.1",port=server.port,username=username,version="1.21.1",auth="offline",world_id=directory.name)
            node_config=directory/"executor-config.json"
            atomic_json(node_config,{"minecraft":{key:getattr(mc,key) for key in mc.__dataclass_fields__}})
            config=replace(original,minecraft=mc,config_path=node_config,runtime_dir=directory/"agent",
                agent=replace(original.agent,max_steps=100,task_timeout_seconds=task["budget"]["wall_time_seconds"]),
                learning=replace(original.learning,mode="B0",ruleset_id="mc01-1.21.1"),
                orchestration=replace(original.orchestration,mode=args.orchestration,max_model_calls=task["budget"]["model_calls"]))
            logs=RuntimeLogs(config.runtime_dir);backend=ExecutorClient(config,logs);memory=ExperienceStore(config.runtime_dir/"memory.sqlite3")
            model=CountedModel(DeepSeekClient(config.model),task["budget"]["model_calls"])
            planner=AgentTeam(model) if args.orchestration=="hierarchical" else RulePlanner() if args.planner=="rules" else LLMPlanner(model)
            service=AgentService(backend,planner,config,logs,emit=lambda text:None,chat_progress=False,memory=memory)
            await service.start();await server.commands([f"tp {username} 0 -60 0",f"clear {username}"])
            instruction=task["player_prompt"]+"原木按本回合累计采集量计数，允许消耗；两件工具最终保留在你自己的背包，不用交给我。"
            if args.orchestration=="hierarchical":
                pending=asyncio.create_task(service.run_single(instruction,public_scene=PUBLIC_SCENE))
            else:pending=asyncio.create_task(service.run_single(instruction+"\n"+PUBLIC_SCENE))
            started=time.monotonic()
            reason="agent_finished"
            while not pending.done():
                if time.monotonic()-started>=task["budget"]["wall_time_seconds"]:reason="timeout";break
                death=await server.command(f"scoreboard players get {username} bd")
                if "has 0 " not in death and "has " in death:reason="death";break
                await asyncio.wait([pending],timeout=.5)
            if not pending.done():
                await service.runner.cancel("benchmark "+reason)
                try:await asyncio.wait_for(asyncio.shield(pending),6)
                except asyncio.TimeoutError:pending.cancel()
            try:outcome=(await pending).to_dict()
            except (Exception,asyncio.CancelledError) as exc:outcome={"end_state":type(exc).__name__,"steps":[]}
            await backend.stop()
            state=await server.capture(username,directory.name)
            atomic_json(directory/"evidence.json",state);atomic_json(directory/"agent-outcome.json",outcome)
            result.update(grade(task,state))
            result.update(agent_end_state=outcome.get("end_state"),termination_reason=reason,duration_seconds=round(time.monotonic()-started,2),model_calls=model.calls,usage=outcome.get("usage",{}))
            # Read before disconnecting; cleanup does not become part of the task.
            await service.shutdown();service=None
    except Exception as exc:result.update(episode_status="invalid",success=None,invalid_reason=type(exc).__name__)
    finally:
        if pending and not pending.done():pending.cancel();await asyncio.gather(pending,return_exceptions=True)
        if service:await service.shutdown()
        if memory:memory.close()
        if logs:logs.close()
        atomic_json(directory/"result.json",result)
    return result

def summarize(results,expected):
    valid=[r for r in results if r["episode_status"]!="invalid"]
    return {"total":expected,"finished":len(results),"valid":len(valid),"successes":sum(r["success"] is True for r in valid),
        "success_rate":sum(r["success"] is True for r in valid)/len(valid) if valid else None,
        "complete":len(valid)==expected,"results":results}

async def run_batch(args):
    tasks=json.loads((BENCH/"tasks.json").read_text(encoding="utf-8"))["tasks"]
    tasks=[t for t in tasks if t["id"] in args.tasks];args.output=args.output.resolve();args.output.mkdir(parents=True,exist_ok=False)
    results=[]
    try:
        for task in tasks:
            print(f"开始 {task['id']}：{task['title']}",flush=True)
            item=await episode(task,args,args.output/task["id"]);results.append(item)
            atomic_json(args.output/"summary.json",summarize(results,len(tasks)))
            print(f"{task['id']}: {item['episode_status']}"+(f" ({item['invalid_reason']})" if item.get("invalid_reason") else ""),flush=True)
    finally:
        atomic_json(args.output/"summary.json",summarize(results,len(tasks)))
        with (args.output/"results.csv").open("w",encoding="utf-8-sig",newline="") as f:
            writer=csv.DictWriter(f,fieldnames=["task_id","title","episode_status","success","agent_end_state","duration_seconds","model_calls","invalid_reason"],extrasaction="ignore");writer.writeheader();writer.writerows(results)
    print(f"结果：{args.output}",flush=True)
    if any(r["episode_status"]=="invalid" for r in results):return 2
    return 0 if results and all(r["success"] for r in results) else 1
