"""Run the shared executor through MC-01 without a model; no materials supplied."""
import asyncio
from dataclasses import replace
from .environment import OwnedServer,fixture_commands,atomic_json
from .grader import grade
from .setup import ROOT
from sim_agent.app.config import load_config
from sim_agent.adapters.mineflayer import ExecutorClient

async def smoke(args):
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=False)
    async with OwnedServer(output/"server",args.java,args.accept_eula,record=getattr(args,"record",False)) as server:
        await server.commands(fixture_commands())
        original=load_config(ROOT/"config.example.json")
        mc=replace(original.minecraft,host="127.0.0.1",port=server.port,username="MC01Smoke",version="1.21.1",world_id="mc01-smoke")
        cfg=output/"executor-config.json";atomic_json(cfg,{"minecraft":{key:getattr(mc,key) for key in mc.__dataclass_fields__}})
        backend=ExecutorClient(replace(original,minecraft=mc,config_path=cfg));effects=[]
        try:
            await backend.start();await server.commands(["tp MC01Smoke 0 -60 0","clear MC01Smoke"])
            await server.start_recording("MC01Smoke")
            async def action(**parameters):
                ack=await backend.request("act",parameters);ident=ack["action_id"]
                for _ in range(1500):
                    state=await backend.request("action_status",{"action_id":ident})
                    if state["status"] in {"succeeded","failed","cancelled"}:
                        effects.append(state);atomic_json(output/"actions.json",effects)
                        if state["status"]!="succeeded":raise RuntimeError(f"{parameters['kind']}: {state.get('error')}")
                        print(parameters["kind"],"ok",flush=True);return
                    await asyncio.sleep(.1)
                raise TimeoutError("Action timeout")
            await action(kind="collect",block="minecraft:oak_log",count=10)
            await action(kind="craft",item="minecraft:oak_planks",count=24)
            await action(kind="craft",item="minecraft:crafting_table",count=1)
            await action(kind="craft",item="minecraft:stick",count=4)
            await action(kind="place",item="minecraft:crafting_table",position={"x":2,"y":-60,"z":0})
            await action(kind="craft",item="minecraft:wooden_pickaxe",count=1)
            await action(kind="craft",item="minecraft:wooden_axe",count=1)
            evidence=await server.capture("MC01Smoke","mc01-smoke");result=grade({},evidence)
            atomic_json(output/"result.json",{"mode":"scripted_executor_not_llm","model_calls":0,"evidence":evidence,**result})
            await server.stop_recording()
            print(result,flush=True);return 0 if result["success"] else 1
        finally:await backend.shutdown()
