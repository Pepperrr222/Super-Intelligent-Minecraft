import test from 'node:test';
import assert from 'node:assert/strict';
import { gatherWood } from '../src/builtin-skills.js';
import { ActionController } from '../src/controller.js';
import { TaskScheduler } from '../src/scheduler.js';
import { IntentRouter } from '../src/interaction.js';
import { CompanionBrain } from '../src/brain.js';
import type { ActionPort } from '../src/task.js';
import type { ActionResult } from '../src/schema.js';

function fixture(type='oak_log') {
  let inventory=0, broken=false, pickup=true, changed=false, drop: { id:number; name:string; position:{x:number;y:number;z:number} } | undefined;
  let position={x:0,y:64,z:0};
  const calls:string[]=[];
  const p={x:1,y:64,z:1};
  const leaves=type.replace(/_log$/,'_leaves');
  const port:ActionPort={busy:false,stop:()=>{},
    query(input:any) {
      if(input.type==='snapshot') return {status:'succeeded',data:{position,inventory:inventory ? [{name:type,count:inventory}] : [],entities:drop ? [drop] : []}};
      if(input.type==='find_blocks') return {status:'succeeded',data:{blocks:[
        ...(broken ? [] : [{known:true,name:type,position:p}]),
        {known:true,name:leaves,position:{x:p.x,y:p.y+1,z:p.z}},
      ]}};
      if(input.type==='inspect_block') {
        const pos=input.position;
        if(pos.x===p.x && pos.y===p.y && pos.z===p.z) return {status:'succeeded',data:{known:true,name:changed?'air':type}};
        return {status:'succeeded',data:{known:true,name:pos.x===1 && pos.y===65 && pos.z===1 ? leaves:'air'}};
      }
      return {status:'failed'};
    },
    async execute(action:any):Promise<ActionResult> {
      calls.push(action.type);
      if(action.type==='navigate') position=action.position;
      if(action.type==='dig') { broken=true; drop={id:1,name:'item',position:p}; }
      if(action.type==='wait' && pickup && drop) { inventory++; drop=undefined; }
      return {id:'a',type:action.type,status:'succeeded',startedAt:0,finishedAt:1};
    }
  };
  return {port,calls,setPickup:(v:boolean)=>{pickup=v;},setChanged:()=>{changed=true;},get inventory(){return inventory;}};
}

test('gather wood uses observed tree and verifies inventory after pickup',async()=>{
  const f=fixture(),r=await gatherWood(f.port,{count:1,searchRadius:16},new AbortController().signal);
  assert.equal(r.status,'ok');assert.equal(r.collected,1);assert.deepEqual(f.calls,['navigate','dig','navigate','wait']);
});
test('auto-selects a nearby supported species when oak is absent',async()=>{
  const f=fixture('birch_log');
  const r=await gatherWood(f.port,{count:1,searchRadius:16},new AbortController().signal);
  assert.equal(r.status,'ok');
  assert.equal(r.woodType,'birch_log');
  assert.equal(r.collected,1);
  assert.equal(f.inventory,1);
});
test('an explicitly requested missing species is not silently replaced',async()=>{
  const f=fixture('birch_log');
  const r=await gatherWood(f.port,{woodType:'oak_log',count:1,searchRadius:16},new AbortController().signal);
  assert.equal(r.status,'blocked');
  assert.equal(r.error?.code,'NO_ELIGIBLE_TREE');
  assert.deepEqual(f.calls,[]);
});
test('missing pickup reports partial instead of success',async()=>{
  const f=fixture();f.setPickup(false);
  const r=await gatherWood(f.port,{count:1,searchRadius:16},new AbortController().signal);
  assert.equal(r.status,'partial');assert.equal(r.error?.code,'PICKUP_UNCONFIRMED');assert.equal(r.collected,0);
});
test('rechecks changed block before digging',async()=>{
  const f=fixture();f.setChanged();
  const r=await gatherWood(f.port,{count:1,searchRadius:16},new AbortController().signal);
  assert.equal(r.error?.code,'TARGET_CHANGED');assert.deepEqual(f.calls,['navigate']);
});
test('abort during navigation does not start digging',async()=>{
  const f=fixture(),abort=new AbortController();
  f.port.execute=async(action:any)=>{f.calls.push(action.type);abort.abort();return {id:'a',type:action.type,status:'cancelled',startedAt:0,finishedAt:1};};
  const r=await gatherWood(f.port,{count:1,searchRadius:16},abort.signal);
  assert.equal(r.status,'cancelled');assert.deepEqual(f.calls,['navigate']);
});
test('chat request compiles into an immediately dispatched dynamic skill', async()=>{
  const message={id:'1',player:'alice',text:'砍树',receivedAt:Date.now()};
  const router=new IntentRouter({complete:async()=>JSON.stringify({kind:'skill',skill:'gather_wood',params:{count:1,searchRadius:16}})});
  const intent=(await router.classify({message})).intent;
  assert.equal(intent.kind,'skill');
  const f=fixture(),brain=new CompanionBrain({query:f.port.query});
  const output=await brain.handle({message,intent,session:{player:'alice',recent:[]}});
  assert.equal(output.kind,'task');if(output.kind!=='task')return;
  assert.equal(output.confirmation,undefined);assert.equal(output.task.steps[0]?.skill?.id,'gather_wood');
  const scheduler=new TaskScheduler(new ActionController(f.port));scheduler.submit(output.task);
  const results=await scheduler.runUntilIdle();
  assert.equal(results.at(-1)?.state,'completed');assert.equal(f.inventory,1);
});

test('a large canopy cannot crowd the trunk out of the block query budget',async()=>{  type P={x:number;y:number;z:number};
  const dist=(a:P,b:P)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
  let position:P={x:0,y:64,z:0};
  let inventory=0;
  let drop:P|undefined;
  const queries:Array<{names:string[];limit:number}>=[];
  const logs:P[]=Array.from({length:10},(_,i)=>({x:3,y:64+i,z:0}));
  // Many leaves near the bot make the shared nearest-block limit look like
  // "only the bottom two logs exist"; the trunk continues above them.
  const leaves:P[]=[];
  for(let y=64;y<=70;y++) for(let x=0;x<=2;x++) for(let z=-1;z<=1;z++) leaves.push({x,y,z});
  for(let y=64;y<=73;y++) leaves.push({x:3,y:y+2,z:1});
  const port:ActionPort={busy:false,stop:()=>{},
    query(input:any) {
      if(input.type==='snapshot') return {status:'succeeded',data:{position,inventory:inventory?[{name:'spruce_log',count:inventory}]:[],entities:drop?[{id:1,name:'item',position:drop}]:[]}};
      if(input.type==='find_blocks') {
        queries.push({names:[...input.names],limit:input.limit});
        const wanted=new Set<string>(input.names);
        const blocks=[...logs.map(name=>({name:'spruce_log',position:name})),...leaves.map(name=>({name:'spruce_leaves',position:name}))]
          .filter(block=>wanted.has(block.name))
          .filter(block=>dist(block.position,position)<=input.radius)
          .sort((a,b)=>dist(a.position,position)-dist(b.position,position))
          .slice(0,input.limit)
          .map(block=>({known:true,name:block.name,position:block.position}));
        return {status:'succeeded',data:{blocks}};
      }
      if(input.type==='inspect_block') {
        const still=logs.some(log=>log.x===input.position.x&&log.y===input.position.y&&log.z===input.position.z);
        return {status:'succeeded',data:still?{known:true,name:'spruce_log',position:input.position}:{known:true,name:'air',position:input.position}};
      }
      return {status:'failed'};
    },
    async execute(action:any):Promise<ActionResult> {
      if(action.type==='navigate') position=action.position;
      if(action.type==='dig') {
        const index=logs.findIndex(log=>log.x===action.position.x&&log.y===action.position.y&&log.z===action.position.z);
        if(index>=0) { drop=logs[index]; logs.splice(index,1); }
      }
      if(action.type==='wait'&&drop) { inventory++; drop=undefined; }
      return {id:'a',type:action.type,status:'succeeded',startedAt:0,finishedAt:1};
    }
  };
  const result=await gatherWood(port,{count:10,searchRadius:16},new AbortController().signal);
  assert.equal(result.status,'ok');
  assert.equal(result.collected,10);
  assert.equal(result.woodType,'spruce_log');
  assert.ok(queries.some(query=>query.names.length===1&&query.names[0]==='spruce_log'));
  assert.ok(queries.some(query=>query.names.length===1&&query.names[0]==='spruce_leaves'));
});

function twoTreeWorld() {
  type P = { x: number; y: number; z: number };
  const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const trees: Array<{ x: number; z: number; logs: P[] }> = [
    { x: 2, z: 0, logs: [{ x: 2, y: 64, z: 0 }, { x: 2, y: 65, z: 0 }] },
    { x: -4, z: 0, logs: [{ x: -4, y: 64, z: 0 }, { x: -4, y: 65, z: 0 }] },
  ];
  const leaves: P[] = trees.map(tree => ({ x: tree.x, y: 66, z: tree.z }));
  let logs: P[] = trees.flatMap(tree => tree.logs);
  let position: P = { x: 0, y: 64, z: 0 };
  let inventory = 0;
  let drop: P | undefined;
  let failedNavigations = 0;
  const digs: number[] = [];
  let reachable = (point: P) => point.x < 0;
  const port: ActionPort = {
    busy: false,
    stop: () => {},
    query(input: any) {
      if (input.type === 'snapshot') {
        return { status: 'succeeded', data: {
          position,
          inventory: inventory ? [{ name: 'oak_log', count: inventory }] : [],
          entities: drop ? [{ id: 1, name: 'item', position: drop }] : [],
        } };
      }
      if (input.type === 'find_blocks') {
        const wanted = new Set<string>(input.names);
        const blocks = [
          ...logs.map(point => ({ name: 'oak_log', position: point })),
          ...leaves.map(point => ({ name: 'oak_leaves', position: point })),
        ]
          .filter(block => wanted.has(block.name))
          .filter(block => dist(block.position, position) <= input.radius)
          .sort((a, b) => dist(a.position, position) - dist(b.position, position))
          .slice(0, input.limit)
          .map(block => ({ known: true, ...block }));
        return { status: 'succeeded', data: { blocks } };
      }
      if (input.type === 'inspect_block') {
        const still = logs.some(log => log.x === input.position.x
          && log.y === input.position.y && log.z === input.position.z);
        return { status: 'succeeded', data: still
          ? { known: true, name: 'oak_log', position: input.position }
          : { known: true, name: 'air', position: input.position } };
      }
      return { status: 'failed' };
    },
    async execute(action: any): Promise<ActionResult> {
      if (action.type === 'navigate') {
        if (!reachable(action.position)) {
          failedNavigations++;
          return { id: 'a', type: action.type, status: 'failed', startedAt: 0, finishedAt: 1,
            error: { code: 'GOAL_NOT_REACHED', message: '无法到达' } };
        }
        position = action.position;
      }
      if (action.type === 'dig') {
        digs.push(action.position.x);
        const index = logs.findIndex(log => log.x === action.position.x
          && log.y === action.position.y && log.z === action.position.z);
        if (index >= 0) {
          drop = logs[index];
          logs.splice(index, 1);
        }
      }
      if (action.type === 'wait' && drop) {
        inventory++;
        drop = undefined;
      }
      return { id: 'a', type: action.type, status: 'succeeded', startedAt: 0, finishedAt: 1 };
    },
  };
  return {
    port,
    get failedNavigations() { return failedNavigations; },
    get digs() { return digs; },
    setReachable(value: (point: P) => boolean) { reachable = value; },
  };
}

test('skips an unreachable tree and harvests another reachable one', async () => {
  const world = twoTreeWorld();
  const result = await gatherWood(world.port, { count: 2, searchRadius: 16 }, new AbortController().signal);

  assert.equal(result.status, 'ok');
  assert.equal(result.collected, 2);
  assert.equal(result.woodType, 'oak_log');
  assert.equal(world.failedNavigations, 1);
  assert.deepEqual(world.digs, [-4, -4]);
});

test('reports no reachable target instead of claiming no tree exists', async () => {
  const world = twoTreeWorld();
  world.setReachable(() => false);
  const result = await gatherWood(world.port, { count: 1, searchRadius: 16 }, new AbortController().signal);

  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'NO_REACHABLE_TARGET');
  assert.match(result.error?.message ?? '', /无法接近或挖掘/);
  assert.deepEqual(world.digs, []);
});
