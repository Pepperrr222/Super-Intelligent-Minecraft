import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { fixture, makeItem } from './fixtures.js';
import { TargetRegistry } from '../src/targets.js';
import { targetQuerySchema } from '../src/schema.js';
import { bindOperation } from '../src/operation-gateway.js';
import { CompanionRuntime } from '../src/runtime.js';
import { AgentLoop } from '../src/agent-loop.js';
import { brainPromptManifest } from '../src/agent-brain.js';
import type { AgentDecision } from '../src/agent-contract.js';

function world() {
  const f=fixture('1.21.1');
  f.bot.whisper=()=>{};
  f.bot.entities[7]={id:7,name:'item',position:new Vec3(3,0,0),getDroppedItem:()=>({name:'spruce_log',count:2})};
  f.bot.entities[8]={id:8,name:'item',position:new Vec3(8,0,0),getDroppedItem:()=>({name:'iron_ingot',count:4})};
  f.bot.entities[9]={id:9,name:'player',username:'alice',position:new Vec3(1,0,0)};
  return f;
}

test('drop filters are distinct from blocks and snapshot references bind to the same live entities',()=>{
  const f=world();
  try {
    const snapshot=f.actions.query({type:'snapshot'}).data as any;
    const found=f.actions.query({type:'observe_targets',itemNames:['iron_ingot'],radius:16,limit:16});
    assert.equal(found.status,'succeeded');
    const targets=(found.data as any).targets;
    assert.equal(targets.length,1);assert.equal(targets[0].entityKind,'item');assert.equal(targets[0].droppedItem.name,'iron_ingot');
    assert.equal(targets[0].ref,snapshot.entities.find((e:any)=>e.id===8).ref);
    const action=bindOperation({type:'navigate',targetRef:targets[0].ref,range:1},f.actions.observations,f.bot);
    assert.deepEqual(action,{type:'navigate',position:{x:8,y:0,z:0},range:1});
    const all=f.actions.query({type:'observe_targets',entityKinds:['item'],radius:16,limit:16});
    assert.equal((all.data as any).targets.length,2);
    const players=f.actions.query({type:'observe_targets',entityNames:['alice'],radius:16,limit:16});
    assert.equal((players.data as any).targets[0].entityKind,'player');
    f.bot.entities[10]={id:10,name:'zombie',type:'hostile',position:new Vec3(4,0,0)};
    f.bot.entities[11]={id:11,name:'cow',type:'animal',position:new Vec3(5,0,0)};
    f.bot.entities[12]={id:12,name:'armor_stand',type:'living',position:new Vec3(6,0,0)};
    const mobs=f.actions.query({type:'observe_targets',entityKinds:['mob'],radius:16,limit:16});
    assert.deepEqual((mobs.data as any).targets.map((t:any)=>t.name),['zombie','cow']);
    delete f.bot.entities[8];
    assert.throws(()=>bindOperation({type:'navigate',targetRef:targets[0].ref,range:1},f.actions.observations,f.bot));
  } finally {f.actions.dispose();}
});

test('repeat observations reuse live references without renewing expired identities or evicting other targets',()=>{
  const f=world();let now=100;
  try {
    const registry=new TargetRegistry(f.bot,()=>now,1000);
    const block=registry.observeBlock({x:2,y:0,z:0})!;
    const q=targetQuerySchema.parse({type:'observe_targets',entityKinds:['item'],radius:16});
    const first=registry.observe(q).targets[0];
    for(let i=0;i<300;i++)registry.observe(q);
    assert.equal(registry.observe(q).targets[0].ref,first.ref);
    assert.equal(registry.resolve(block.ref,['block']).name,'furnace');
    now=1101;
    assert.throws(()=>registry.resolve(first.ref,['entity']),/过期/);
    const next=registry.observe(q).targets[0];assert.notEqual(next.ref,first.ref);
    f.bot.entities[7]={...f.bot.entities[7]};
    assert.throws(()=>registry.resolve(next.ref,['entity']),/已改变/);
  } finally {f.actions.dispose();}
});

test('snapshot entity cap is explicit and block queries expose executable references too',()=>{
  const f=world();
  try {
    for(let i=20;i<90;i++)f.bot.entities[i]={id:i,name:'item',position:new Vec3(2,0,0)};
    const snapshot=f.actions.query({type:'snapshot'}).data as any;
    assert.equal(snapshot.entities.length,64);assert.equal(snapshot.entitiesTruncated,true);
    f.bot.findBlocks=()=>[new Vec3(2,0,0)];
    const found=f.actions.query({type:'find_blocks',names:['furnace']}).data as any;
    assert.ok(found.blocks[0].ref);
    assert.equal(bindOperation({type:'dig',targetRef:found.blocks[0].ref},f.actions.observations,f.bot).type,'dig');
  } finally {f.actions.dispose();}
});

const goal:AgentDecision={kind:'goal',mode:'new',objective:'捡起两处掉落物',criteria:[{id:'pickup',text:'获得2个云杉原木与4个铁锭，地面目标已消失'}],assumptions:[]};
function complete(p:any):AgentDecision {
  const observed=p.evidence.find((e:any)=>e.id===p.freshEvidenceId)?.data?.data;
  assert.ok(observed.inventory.some((i:any)=>i.name==='spruce_log'&&i.count===2));
  assert.ok(observed.inventory.some((i:any)=>i.name==='iron_ingot'&&i.count===4));
  assert.equal(observed.entities.filter((e:any)=>e.entityKind==='item').length,0);
  return {kind:'finish',assessment:{verdicts:[{criterionId:'pickup',verdict:'met',evidenceIds:[p.freshEvidenceId],explanation:'新库存和地面观测一致'}],omittedRequirements:[],summary:'两处物品已捡起。'}};
}
async function pickupScenario(mode:'batches'|'stage'|'correct_query') {
  const f=world();f.actions.dispose();
  const calls:string[]=[],moves:number[]=[];let step=0,failedQuery=false;
  f.bot.pathfinder.goto=async(goal:any)=>{
    f.bot.entity.position=new Vec3(goal.x,goal.y,goal.z);moves.push(goal.x);
    for(const [id,entity] of Object.entries(f.bot.entities) as Array<[string,any]>) {
      if(entity.name==='item'&&entity.position.distanceTo(f.bot.entity.position)<1) {
        const item=entity.getDroppedItem();const slot=item.name==='spruce_log'?9:10;
        f.slots[slot]=makeItem(item.name,item.count,slot);delete f.bot.entities[id];
      }
    }
  };
  const runtime=new CompanionRuntime(f.bot,{owners:['alice'],agent:{approvedPromptHash:brainPromptManifest().hash},
    llm:{complete:async request=>{
      assert.ok(request.system.startsWith('SIM_AGENT_ROLE=decision\n'));calls.push('decision');
      const p=JSON.parse(request.user);
      if(p.trigger==='player_message')return JSON.stringify(goal);
      let decision:AgentDecision;
      if(mode==='correct_query'&&!failedQuery) {
        failedQuery=true;decision={kind:'query',query:targetQuerySchema.parse({type:'observe_targets',names:['iron_ingot'],entities:true})};
      } else if(step++===0) {
        if(mode==='correct_query') {
          assert.equal(p.lastFailure.data.code,'QUERY_FAILED');
          assert.match(p.lastFailure.data.result.error,/UNKNOWN_BLOCK/);
          assert.ok(p.queryContracts.observe_targets.input.includes('itemNames'));
        }
        decision=mode==='stage'?{kind:'plan',plan:{purpose:'观察并逐个拾取掉落物',entry:'scan',guards:[],maxOperations:4,maxDurationMs:10000,nodes:[
          {id:'scan',kind:'query',query:{type:'observe_targets',params:{itemNames:['spruce_log','iron_ingot'],radius:16,limit:16}},bindings:[],next:'each'},
          {id:'each',kind:'foreach',from:{node:'scan',path:['targets']},limit:16,body:'walk',next:'done'},
          {id:'walk',kind:'act',operation:{type:'navigate',params:{range:0.5}},bindings:[{parameter:['targetRef'],from:{node:'each',path:['ref']}}],next:'each'},
          {id:'done',kind:'end',outcome:'stage_complete',reason:'此列表处理完，继续核对整体目标'}]}}
          :{kind:'query',query:targetQuerySchema.parse({type:'observe_targets',itemNames:['spruce_log','iron_ingot'],radius:16,limit:16})};
      } else {
        const observed=p.evidence.find((e:any)=>e.id===p.freshEvidenceId)?.data?.data;
        const drop=observed.entities.find((e:any)=>e.entityKind==='item');
        decision=drop?{kind:'propose',purpose:'走到这处掉落物拾取',operations:[{type:'navigate',targetRef:drop.ref,range:0.5}]}:complete(p);
      }
      return JSON.stringify(decision);
    }}});
  try {
    assert.ok(runtime.interaction instanceof AgentLoop);
    await runtime.interaction.handle({id:'pickup',text:'捡一下',player:'alice',receivedAt:Date.now()});
    await runtime.interaction.whenIdle();
    const state=runtime.interaction.snapshot;
    assert.equal(state.goal?.status,'completed',JSON.stringify(state.events.filter(e=>e.kind==='error').map(e=>e.data)));
    assert.deepEqual(moves,[3,8]);assert.equal(state.goal?.originalRequest,'捡一下');
    assert.equal(calls.length,mode==='stage'?3:mode==='correct_query'?6:5);
    assert.equal(state.events.filter(e=>e.kind==='review').length,0);
  } finally {runtime.stop();}
}
test('one decision model queries then picks up two objects through real reference binding and short batches',()=>pickupScenario('batches'));
test('optional stage binds observed drop references across two navigation steps without intermediate model calls',()=>pickupScenario('stage'));
test('failed tool parameters are returned to the same decision model and corrected without losing the goal',()=>pickupScenario('correct_query'));
