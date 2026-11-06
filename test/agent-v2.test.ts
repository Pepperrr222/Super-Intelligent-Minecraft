import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Vec3 } from 'vec3';
import { AgentLoop, type AgentLoopOptions } from '../src/agent-loop.js';
import { brainPromptManifest } from '../src/agent-brain.js';
import { FileAgentStore, MemoryAgentStore } from '../src/agent-store.js';
import { emptyAgentState } from '../src/agent-contract.js';
import { ActionController } from '../src/controller.js';
import { TaskScheduler } from '../src/scheduler.js';
import { SkillRegistry } from '../src/skill-runtime.js';
import { ActionExecutor } from '../src/executor.js';
import type { BasicOperation } from '../src/schema.js';
import { basicOperationSchema } from '../src/schema.js';
import { fixture, tick } from './fixtures.js';
import { CompanionRuntime } from '../src/runtime.js';
import { handPrerequisite, stableFacts } from '../src/agent-preflight.js';
import { ContainerMemory } from '../src/resource-memory.js';
import { itemDetails } from '../src/observation.js';
import {stagePlanSchema} from '../src/stage-plan.js';

const route = (objective = '过来并穿上胸甲') => ({ kind: 'goal', mode: 'new', objective,
  criteria: [{ id: 'arrive', text: '到达玩家附近' }, { id: 'wear', text: '胸甲穿在身上' }], assumptions: [] });
const advance = (next: string) => ({ kind: 'advance', next, constraints: ['保持原要求'], expectedEvidence: ['当前实际状态'] });
const propose = (...operations: BasicOperation[]) => ({ kind: 'propose', purpose: '推进目标', operations });
const assess = (payload: any, met = true) => ({ verdicts: payload.criteria.map((c: any) => ({ criterionId: c.id,
  verdict: met ? 'met' : 'not_met', evidenceIds: [payload.evidence.at(-1).id], explanation: '依据客户端实际状态' })),
  omittedRequirements: [], summary: met ? '完整目标已完成。' : '还没有完成。' });
type Handler = (role: string, payload: any, signal?: AbortSignal) => unknown | Promise<unknown>;
async function pendingStore() {
  const store = new MemoryAgentStore();
  const h = harness(role => role === 'route' ? route() : { kind: 'blocked', reason: '准备恢复样本' }, { store });
  await h.message('制作工具'); await h.loop.whenIdle(); h.loop.stop();
  const state = store.load(); state.goal!.status = 'active';
  state.goal!.pendingBatch = { id: 'uncertain', revision: 1, operations: [{ type: 'wait', durationMs: 1 }] };
  state.events.push({ id: 'failed-batch-evidence', at: Date.now(), goalId: state.goal!.id, revision: 1, kind: 'batch',
    data: { id: 'uncertain', state: 'failed', stepResults: [] } });
  state.sequence++; store.save(state); return store;
}

test('preflight returns missing hand prerequisite to model, accepting an explicit equip-place correction', async () => {
  let proposals = 0;
  const h = harness((role, p) => {
    if (role === 'route') return route('放置工作台');
    if (role === 'director') return proposals >= 2 ? { kind: 'assess' } : advance('放工作台');
    if (role === 'executor') {
      proposals++;
      const place: BasicOperation = { type: 'place', targetRef: randomUUID(), item: 'crafting_table', face: 'up' };
      if (proposals === 1) return propose(place);
      assert.ok(p.results.some((r: any) => r.correction?.includes('equip')));
      return propose({ type: 'equip', item: 'crafting_table', destination: 'hand' }, place);
    }
    return assess(p);
  });
  await h.message('放工作台'); await h.loop.whenIdle();
  assert.deepEqual(h.operations.map(op => op.type), ['equip', 'place']);
  assert.equal(h.calls.filter(role => role === 'review').length, 0);
  assert.equal(h.loop.snapshot.goal?.status, 'completed'); h.loop.stop();
});

test('hand preflight applies to any placeable item and invalidating hand operations', () => {
  const place: BasicOperation = { type: 'place_entity', targetRef: randomUUID(), item: 'oak_boat', face: 'up' };
  assert.equal(handPrerequisite([place], { heldItem: { name: 'oak_boat' } }), undefined);
  assert.ok(handPrerequisite([{ type: 'select_slot', slot: 2 }, place], { heldItem: { name: 'oak_boat' } }));
  assert.ok(handPrerequisite([{ type: 'equip', item: 'oak_boat', destination: 'off-hand' }, place], {}));
});

test('reconciliation accepts failed batch and historical context alongside fresh successful observation', async () => {
  const store = await pendingStore();
  const h = harness((role, p) => role === 'director' ? p.goal.pendingBatch
    ? { kind: 'reconcile', evidenceIds: ['failed-batch-evidence', p.evidence.at(-1).id], explanation: '对照失败批次和新观察核对' }
    : { kind: 'assess' } : assess(p), { store });
  h.loop.start(); await h.loop.whenIdle();
  assert.equal(h.loop.snapshot.goal?.status, 'completed'); assert.equal(h.operations.length, 0); h.loop.stop();
});

test('reconciliation requires a fresh successful world observation and stops repeated protocol failures', async () => {
  const store = await pendingStore(); let tries = 0;
  const h = harness(() => {
    tries++;
    // Self-motion used to reset general noProgress and hide this loop.
    h.world.position.x++;
    return { kind: 'reconcile', evidenceIds: ['failed-batch-evidence'], explanation: '缺少新观察的错误对账' };
  }, { store });
  h.loop.start(); await h.loop.whenIdle();
  assert.equal(tries, 3); assert.equal(h.loop.snapshot.goal?.status, 'paused');
  assert.ok(h.loop.snapshot.goal?.pendingBatch); assert.equal(h.operations.length, 0);
  const error = h.loop.snapshot.events.filter(e => e.kind === 'error').at(-1)?.data as any;
  assert.ok(error.eligibleFreshEvidenceIds.length); h.loop.stop();
});

test('spent and expired task budget does not block inventory replies or explicit replacement', async () => {
  const store = await pendingStore(); const state = store.load();
  state.goal!.status = 'paused'; state.goal!.budget.calls = 0; state.goal!.deadline = Date.now() - 1;
  const oldId = state.goal!.id; state.sequence++; store.save(state);
  const h = harness((role, p) => {
    if (role === 'route') return p.message.text === '背包里有什么' ? { kind: 'respond', text: '背包有钻石胸甲。' } : { ...route('新目标'), mode: 'replace' };
    return { kind: 'blocked', reason: '新目标已进入主控' };
  }, { store });
  await h.message('背包里有什么'); await h.loop.whenIdle();
  assert.ok(h.sent.includes('背包有钻石胸甲。')); assert.equal(h.loop.snapshot.goal?.budget.calls, 0);
  assert.equal(h.loop.snapshot.goal?.id, oldId);
  await h.message('放弃旧任务改做新的'); await h.loop.whenIdle();
  assert.notEqual(h.loop.snapshot.goal?.id, oldId); assert.equal(h.loop.snapshot.goal?.originalRequest, '放弃旧任务改做新的'); h.loop.stop();
});

test('repeating a depleted task as amend renews a bounded window and preserves the goal without empty reconciliation',async()=>{
  const store=await pendingStore(),state=store.load();
  state.goal!.status='paused';state.goal!.budget={calls:0,operations:0,activeMs:0};state.goal!.deadline=Date.now()-1;
  state.goal!.pendingBatch=undefined;state.goal!.noProgress=8;const id=state.goal!.id,original=state.goal!.originalRequest;
  state.sequence++;store.save(state);
  let directed=false;
  const h=harness((role,p)=>{
    if(role==='route')return {...route('继续完整任务'),mode:'amend'};
    assert.equal(role,'director');directed=true;
    assert.equal(p.goal.id,id);assert.equal(p.goal.originalRequest,original);assert.equal(p.goal.status,'active');
    assert.equal(p.goal.budget.calls,5);assert.equal(p.goal.budget.operations,12);assert.ok(p.goal.deadline>Date.now());
    return {kind:'blocked',reason:'已到达新执行轮次'};
  },{store,maxCalls:6,maxOperations:12,activeMs:5000});
  await h.message('继续完整任务');await h.loop.whenIdle();assert.ok(directed);
  assert.equal(h.loop.snapshot.events.filter(e=>(e.data as any)?.reason==='execution_window_renewed').length,1);
  assert.equal(h.operations.length,0);h.loop.stop();
});

test('explicit resume renews depleted budget but retains uncertain operations and reconciles first',async()=>{
  const store=await pendingStore(),state=store.load();state.goal!.status='paused';state.goal!.budget.calls=0;
  state.sequence++;store.save(state);let checked=false;
  const h=harness((role,p)=>{
    assert.equal(role,'director');checked=true;assert.equal(p.goal.pendingBatch.id,'uncertain');
    assert.equal(p.goal.status,'reconciling');assert.equal(p.goal.budget.calls,5);
    return {kind:'blocked',reason:'必须先对账'};
  },{store,maxCalls:6});
  const message={id:'same-resume-id',player:'alice',text:'继续',receivedAt:Date.now()};
  await h.loop.handle(message);await h.loop.whenIdle();assert.ok(checked);const calls=h.calls.length;
  await h.loop.handle(message);await h.loop.whenIdle();assert.equal(h.calls.length,calls);
  assert.equal(h.loop.snapshot.events.filter(e=>(e.data as any)?.reason==='execution_window_renewed').length,1);
  assert.equal(h.operations.length,0);h.loop.stop();
});

test('startup and world wakeups cannot refill execution budgets without a new player instruction',async()=>{
  const store=await pendingStore(),state=store.load();state.goal!.status='active';state.goal!.budget.calls=0;
  state.sequence++;store.save(state);let wake!:()=>void;
  const h=harness(()=>{throw new Error('no model budget');},{store,subscribeWorld:fn=>{wake=fn;return()=>{};}});
  h.loop.start();await h.loop.whenIdle();wake();await h.loop.whenIdle();
  assert.equal(h.loop.snapshot.goal!.budget.calls,0);assert.equal(h.calls.length,0);
  assert.equal(h.loop.snapshot.events.filter(e=>(e.data as any)?.reason==='execution_window_renewed').length,0);h.loop.stop();
});

test('resuming with remaining budget keeps the existing allowance and another owner cannot renew it',async()=>{
  const store=await pendingStore(),state=store.load();state.goal!.status='paused';state.goal!.budget.calls=9;
  state.sequence++;store.save(state);
  const h=harness(()=>({kind:'blocked',reason:'测试暂停'}),{store,owners:['alice','bob']});
  await h.message('继续','bob');await h.loop.whenIdle();assert.equal(h.loop.snapshot.goal!.budget.calls,9);
  await h.message('继续');await h.loop.whenIdle();assert.equal(h.loop.snapshot.goal!.budget.calls,8);
  assert.equal(h.loop.snapshot.events.filter(e=>(e.data as any)?.reason==='execution_window_renewed').length,0);h.loop.stop();
});

test('a self-contained new goal replaces a paused old goal and gets its own original request and allowance',async()=>{
  const store=await pendingStore(),state=store.load();state.goal!.status='paused';state.goal!.budget.calls=22;
  state.goal!.pendingBatch=undefined;state.goal!.originalRequest='挖20个圆石';const old=state.goal!.id;
  state.sequence++;store.save(state);
  const h=harness((role,p)=>{
    if(role==='route')return {kind:'goal',mode:'new',objective:'挖10个石头并做一把石镐',criteria:[{id:'mine',text:'挖10个石头'},{id:'craft',text:'制作石镐'}],assumptions:[]};
    assert.notEqual(p.goal.id,old);assert.equal(p.goal.originalRequest,'挖10个石头并做一把石镐');
    assert.equal(p.goal.budget.calls,59);assert.ok(!JSON.stringify(p.goal.criteria).includes('20'));
    return {kind:'blocked',reason:'新任务上下文已检查'};
  },{store});
  await h.message('挖10个石头并做一把石镐');await h.loop.whenIdle();
  assert.ok(!h.sent.some(s=>s.includes('请说明')));h.loop.stop();
});

test('an explicit amended instruction on a paused task gets a fresh window even with 22 calls left',async()=>{
  const store=await pendingStore(),state=store.load();state.goal!.status='paused';state.goal!.budget.calls=22;
  state.sequence++;store.save(state);
  const h=harness((role,p)=>{
    if(role==='route')return {...route('还要做石镐'),mode:'amend'};
    assert.equal(p.goal.budget.calls,59);assert.equal(p.goal.pendingBatch.id,'uncertain');
    return {kind:'blocked',reason:'仍须对账'};
  },{store});
  await h.message('还要做石镐');await h.loop.whenIdle();h.loop.stop();
});

test('stable query progress ignores renewed references and timestamps but preserves actual facts', () => {
  const a = { targets: [{ ref: 'old', position: { x: 1 }, name: 'stone', observedAt: 1, expiresAt: 2 }], timestamp: 1 };
  const b = { targets: [{ ref: 'new', position: { x: 1 }, name: 'stone', observedAt: 3, expiresAt: 4 }], timestamp: 3 };
  assert.deepEqual(stableFacts(a), stableFacts(b)); b.targets[0]!.name = 'air';
  assert.notDeepEqual(stableFacts(a), stableFacts(b));
});

function harness(handler: Handler, options: AgentLoopOptions = {}) {
  const sent: string[] = [], operations: BasicOperation[] = [], calls: string[] = [];
  const world = { position: { x: 0, y: 0, z: 0 }, inventory: [{ name: 'diamond_chestplate', count: 1 }],
    equipment: [] as any[], heldItem: null as any, version: '1.21.1', dimension: 'overworld', sessionId: 'sim-session' };
  let native: ((op: BasicOperation) => Promise<void>) | undefined;
  const engine = new ActionExecutor(async (action, ctx) => {
    assert.equal(action.type, 'operate'); if (action.type !== 'operate') throw new Error('unexpected action');
    const op = action.operation; operations.push(op);
    if (native) await native(op);
    ctx.check();
    if (op.type === 'navigate') world.position.x = 2;
    if (op.type === 'equip') {
      if (op.destination === 'hand') world.heldItem = { name: op.item, count: 1 };
      else world.equipment = [{ slot: 6, item: { name: op.item, count: 1 } }];
    }
    return { operation: op.type, evidence: 'client_observed', ...op };
  });
  const actions = { execute: engine.execute.bind(engine), stop: engine.stop.bind(engine), get busy() { return engine.busy; },
    query: (_q: unknown) => ({ status: 'succeeded', data: structuredClone(world) }) };
  const registry = new SkillRegistry();
  const controller = new ActionController(actions, registry), scheduler = new TaskScheduler(controller, undefined, registry);
  // Reuse the historical scenario scripts as a response builder, not as model calls.
  // The runtime MUST make only decision requests; calls counts actual complete() invocations.
  const llm = { async complete(input: any) {
    const role = input.system.match(/SIM_AGENT_ROLE=(\w+)/)[1]; assert.equal(role,'decision'); calls.push(role);
    const packed=JSON.parse(input.user), p=packed.input ?? packed;
    if(p.trigger==='player_message') return JSON.stringify(await handler('route',p,input.signal));
    const error=p.lastFailure?.data;
    const fixtureContext={...p,criteria:p.goal.criteria,originalRequest:p.goal.originalRequest,messages:p.goal.messages,
      currentRevision:p.goal.revision,results:error?[{correction:error.reason,...error}]:[]};
    let decision:any=await handler('director',fixtureContext,input.signal);
    if(decision.kind==='advance') decision=await handler('executor',{...fixtureContext,direction:decision},input.signal);
    if(decision.kind==='stage_done') decision=await handler('director',fixtureContext,input.signal);
    if(decision.kind==='assess') decision={kind:'finish',assessment:await handler('assessor',fixtureContext,input.signal)};
    if(decision.kind==='cannot_execute') decision={kind:'blocked',reason:decision.reason};
    return JSON.stringify(decision);
  } };
  const loop = new AgentLoop({ onMessage: () => () => {}, send: (_p, text) => { sent.push(text); } }, actions, controller, scheduler,
    { owners: ['alice'], director: llm, executor: llm, ...options });
  const message = (text: string, player = 'alice') => loop.handle({ id: randomUUID(), player, text, receivedAt: Date.now() });
  return { loop, sent, operations, calls, world, controller, scheduler, message, setNative: (fn: typeof native) => { native = fn; } };
}
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); } throw new Error('wait failed'); }

test('V2 completes a multi-batch goal without skills or a second player command', async () => {
  let steps = 0;
  const h = harness((role, p) => {
    if (role === 'route') return route();
    if (role === 'director') return steps < 2 ? advance(steps === 0 ? '到玩家附近' : '穿胸甲') : { kind: 'assess' };
    if (role === 'executor') return ++steps === 1 ? propose({ type: 'navigate', targetRef: randomUUID(), range: 2 })
      : propose({ type: 'equip', item: 'diamond_chestplate', destination: 'torso' });
    if (role === 'assessor') { assert.equal(p.evidence.filter((e: any) => e.kind === 'batch').length, 2); return assess(p); }
    throw new Error(role);
  });
  await h.message('过来并穿上胸甲'); await h.loop.whenIdle();
  assert.equal(h.loop.snapshot.goal?.status, 'completed');
  assert.equal(h.loop.snapshot.goal?.originalRequest, '过来并穿上胸甲');
  assert.deepEqual(h.operations.map(op => op.type), ['navigate', 'equip']);
  assert.equal(h.controller.skills.list().length, 0);
  assert.ok(h.calls.every(role => role === 'decision'));
  h.loop.stop();
});

const twelveStepPlan=()=>stagePlanSchema.parse({purpose:'在同一阶段执行明确的十二步',entry:'loop',maxOperations:12,maxDurationMs:10000,nodes:[
  {id:'loop',kind:'repeat',maxIterations:12,body:'action',next:'done'},
  {id:'action',kind:'act',operation:{type:'wait',params:{durationMs:1}},bindings:[],next:'loop'},
  {id:'done',kind:'end',outcome:'stage_complete',reason:'阶段结束，需要主控验收完整要求'}]});
test('V2 stage executes twelve operations with one plan decision and no model handoffs',async()=>{
  let planned=false;const checkpoints:number[]=[];
  const store=new MemoryAgentStore(),save=store.save.bind(store);
  store.save=s=>{if(s.goal?.stage)checkpoints.push(s.goal.stage.operations);save(s);};
  const h=harness((role,p)=>{
    if(role==='route')return route('执行阶段');
    if(role==='director')return planned?{kind:'assess'}:advance('执行明确阶段');
    if(role==='executor'){planned=true;return {kind:'plan',plan:twelveStepPlan()};}
    assert.equal(p.evidenceIndex.filter((e:any)=>e.kind==='batch').length,12);return assess(p);
  },{store});
  await h.message('执行阶段');await h.loop.whenIdle();
  assert.equal(h.operations.length,12);assert.equal(h.calls.filter(r=>r==='review').length,0);
  assert.deepEqual(h.calls,['decision','decision','decision']);
  assert.equal(h.loop.snapshot.goal?.budget.calls,58);
  assert.equal(h.loop.snapshot.goal?.stage?.cursor,'done');assert.equal(h.loop.snapshot.goal?.stage?.status,'stage_complete');
  assert.equal(h.loop.snapshot.goal?.status,'completed');assert.ok(checkpoints.includes(1)&&checkpoints.includes(12));h.loop.stop();
});
test('V2 interrupted persisted stage is surfaced for replanning after restart and never automatically replayed',async()=>{
  const store=await pendingStore(),s=store.load();s.goal!.pendingBatch=undefined;
  const plan=twelveStepPlan();s.goal!.stage={id:'old-stage',revision:s.goal!.revision,plan,cursor:'action',status:'running',
    deadline:Date.now()+10000,transitions:4,operations:2,outputs:{},counts:{loop:2},frames:{},pendingNode:'action'};
  s.sequence++;store.save(s);
  const h=harness((role,p)=>{
    assert.equal(role,'director');assert.equal(p.goal.stage.status,'interrupted');assert.equal(p.goal.stage.pendingNode,'action');
    return {kind:'blocked',reason:'先根据旧动作记录重新制定剩余方案'};
  },{store});h.loop.start();await h.loop.whenIdle();assert.equal(h.operations.length,0);h.loop.stop();
});
test('V2 cancellation inside a stage retains native lease and prevents the following iteration',async()=>{
  let release!:()=>void;
  const h=harness(role=>role==='route'?route():role==='director'?advance('阶段'):{kind:'plan',plan:twelveStepPlan()});
  h.setNative(async()=>{await new Promise<void>(r=>release=r);});
  const work=h.message('执行阶段');await until(()=>!!release);
  await h.message('停止');assert.equal(h.controller.busy,true);assert.equal(h.operations.length,1);
  release();await work;await h.loop.whenIdle();assert.equal(h.operations.length,1);assert.equal(h.loop.snapshot.goal?.status,'cancelled');
  assert.equal(h.loop.snapshot.goal?.stage?.status,'interrupted');h.loop.stop();
});
test('V2 world events can interrupt a running guarded stage before the native action completes',async()=>{
  let release!:()=>void,wake!:()=>void,unsubscribed=false,planned=false;
  const plan=twelveStepPlan();plan.guards=[{kind:'health_at_least',health:8}];
  const h=harness(role=>role==='route'?route():role==='director'?(planned?{kind:'blocked',reason:'约束已失效'}:advance('受约束的阶段')):
    (planned=true,{kind:'plan',plan}),
    {subscribeWorld:fn=>{wake=fn;return()=>{unsubscribed=true;};}});
  (h.world as any).value=true;
  h.setNative(async()=>{await new Promise<void>(r=>release=r);});
  const work=h.message('执行阶段');await until(()=>!!release);
  (h.world as any).value=false;wake();assert.equal(h.controller.busy,true);
  release();await work;await h.loop.whenIdle();
  assert.equal(h.operations.length,1);assert.equal(h.loop.snapshot.goal?.stage?.status,'interrupted');
  assert.match(h.loop.snapshot.goal?.stage?.reason??'',/GUARD/);assert.ok(unsubscribed);h.loop.stop();
});

test('V2 continues a bounded stage without model reviews even when requestReview is true or parameters change',async()=>{
  let steps=0, finished=false;
  const h=harness((role,p)=>{
    if(role==='route') return route();
    if(role==='director') return finished?{kind:'assess'}:advance('移动并调整装备');
    if(role==='executor') {
      if(++steps===4) {finished=true;return {kind:'stage_done',summary:'阶段已完成'};}
      return {...propose(steps<=2?{type:'navigate',targetRef:randomUUID(),range:2}:{type:'equip',item:'diamond_chestplate',destination:'torso'}),
        continueStage:true,requestReview:true}; // Legacy field cannot restore the deleted review loop.
    }
    return assess(p);
  });
  await h.message('移动并穿胸甲');await h.loop.whenIdle();
  assert.equal(h.operations.length,3);assert.equal(h.calls.length,5);
  assert.equal(h.calls.filter(r=>r==='review').length,0);assert.equal(h.loop.snapshot.goal?.status,'completed');h.loop.stop();
});

test('V2 recipe preflight still returns a correction before any write',async()=>{
  let attempts=0;
  const h=harness((role,p)=>{
    if(role==='route')return route();
    if(role==='director')return attempts?{kind:'blocked',reason:'测试结束'}:advance('制作');
    if(role==='executor') {
      if(attempts++) {assert.ok(p.results.some((r:any)=>r.correction==='配方产物不匹配'));return {kind:'cannot_execute',reason:'重新查配方'};}
      return propose({type:'craft',item:'stick',count:4,recipeRef:'a'.repeat(64)});
    }
    throw new Error('不应调用复核或验收');
  },{validateOperations:()=> '配方产物不匹配'});
  await h.message('制作');await h.loop.whenIdle();assert.equal(h.operations.length,0);assert.ok(!h.calls.includes('review'));h.loop.stop();
});

test('V2 container memory is persisted immediately and restored before routing after restart',async()=>{
  const f=fixture('1.21.1'),store=new MemoryAgentStore();
  const memory=new ContainerMemory(f.bot,'test-world');
  const h=harness(()=>({kind:'blocked',reason:'test'}),{store,memory});
  memory.capture({x:1,y:0,z:0},{inventoryStart:1,slots:[{name:'oak_planks',count:8,metadata:0}]},itemDetails);
  assert.equal(store.load().resources!.containers[0]!.slots[0]!.count,8);h.loop.stop();await h.loop.whenIdle();
  const nextMemory=new ContainerMemory(f.bot,'test-world');
  const next=harness(()=>({kind:'blocked',reason:'test'}),{store,memory:nextMemory});
  assert.equal(nextMemory.query(['oak_planks']).containers[0]!.status,'historical');
  next.loop.stop();f.actions.dispose();
});

test('V2 final assessment can correct a semantic mistake after execution without restoring proposal review', async () => {
  let proposed = 0, assessed = 0;
  const h = harness((role, p) => {
    if (role === 'route') return route('穿胸甲');
    if (role === 'director') return proposed === assessed ? advance('穿到胸甲槽') : { kind: 'assess' };
    if (role === 'executor') return propose({ type: 'equip', item: 'diamond_chestplate', destination: ++proposed === 1 ? 'hand' : 'torso' });
    assert.equal(role, 'assessor'); assessed++;
    return assess(p, h.world.equipment.length > 0);
  });
  await h.message('穿胸甲'); await h.loop.whenIdle();
  assert.deepEqual(h.operations.map(op => (op as any).destination), ['hand', 'torso']);
  assert.equal(assessed, 2); assert.ok(!h.calls.includes('review'));
  assert.equal(h.loop.snapshot.goal?.status, 'completed'); assert.equal(h.sent.some(t => t.includes('确认吗')), false);
  h.loop.stop();
});

test('V2 unmet natural-language assessment continues work; fabricated evidence cannot complete', async () => {
  let attempts = 0;
  const h = harness((role, p) => {
    if (role === 'route') return route();
    if (role === 'director') return attempts > 1 ? { kind: 'blocked', reason: '没有证据' } : { kind: 'assess' };
    if (role === 'assessor') { attempts++; const a = assess(p); a.verdicts[0].evidenceIds = ['invented']; return a; }
    throw new Error(role);
  });
  await h.message('完整要求'); await h.loop.whenIdle();
  assert.equal(attempts, 2); assert.equal(h.loop.snapshot.goal?.status, 'paused');
  assert.equal(h.sent.includes('完整目标已完成。'), false); h.loop.stop();
});

test('V2 stop invalidates an in-flight initial model response without resurrecting the request', async () => {
  let release!: (value: unknown) => void;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  const handling = h.message('执行任务'); await until(() => !!release);
  await h.message('停'); release(route()); await handling; await h.loop.whenIdle();
  assert.equal(h.operations.length, 0); assert.equal(h.loop.snapshot.goal, null);
  assert.equal(h.calls.length, 1); h.loop.stop();
});

test('V2 stop during native work retains actuator lease and prevents remaining batch operations', async () => {
  let release!: () => void;
  const h = harness(role => role === 'route' ? route() : role === 'director' ? advance('穿戴') : propose({ type: 'equip', item: 'diamond_chestplate', destination: 'torso' }, { type: 'unequip', destination: 'torso' }));
  h.setNative(() => new Promise<void>(resolve => { release = resolve; }));
  await h.message('执行任务'); await until(() => !!release);
  await h.message('停'); await h.loop.whenIdle();
  assert.equal(h.controller.busy, true); assert.equal(h.operations.length, 1);
  assert.equal(h.loop.snapshot.goal?.status, 'cancelled'); release(); await tick();
  assert.equal(h.controller.busy, false); h.loop.stop();
});

test('V2 storage failure at write intent prevents all game effects', async () => {
  class FailingStore extends MemoryAgentStore { override save(s: any) {
    if (s.events.at(-1)?.kind === 'submitted') throw new Error('disk full'); super.save(s);
  } }
  const h = harness(role => role === 'route' ? route() : role === 'director' ? advance('穿戴') : propose({ type: 'equip', item: 'diamond_chestplate', destination: 'torso' }), { store: new FailingStore() });
  await h.message('穿戴'); await h.loop.whenIdle(); assert.equal(h.operations.length, 0); h.loop.stop();
});

test('V2 recovery reconciles an uncertain write from new evidence and never replays it', async () => {
  const store = new MemoryAgentStore();
  const first = harness(role => role === 'route' ? route() : { kind: 'blocked', reason: '先暂停' }, { store });
  await first.message('穿戴'); await first.loop.whenIdle(); first.loop.stop();
  const state = store.load(); state.goal!.status = 'active';
  state.goal!.pendingBatch = { id: 'old-batch', revision: 1, operations: [{ type: 'equip', item: 'diamond_chestplate', destination: 'torso' }] };
  state.sequence++; store.save(state);
  const second = harness((role, p) => role === 'director' ? p.goal.pendingBatch
    ? { kind: 'reconcile', evidenceIds: [p.evidence.at(-1).id], explanation: '观察到胸甲槽已经穿戴，无需重复' }
    : { kind: 'assess' } : assess(p), { store });
  second.world.equipment = [{ slot: 6, item: { name: 'diamond_chestplate' } }];
  second.loop.start(); await second.loop.whenIdle();
  assert.equal(second.operations.length, 0); assert.equal(second.loop.snapshot.goal?.status, 'completed'); second.loop.stop();
});

test('V2 enforces a goal-wide model budget across planning and schema retries', async () => {
  const h = harness(role => role === 'route' ? route() : role === 'director' ? advance('检查') : { kind: 'not_a_real_operation' }, { maxCalls: 3 });
  await h.message('检查'); await h.loop.whenIdle();
  assert.equal(h.loop.snapshot.goal?.budget.calls, 1); assert.equal(h.loop.snapshot.goal?.status, 'paused');
  assert.equal(h.operations.length, 0); h.loop.stop();
});

test('V2 ordinary replies use one call and cannot mutate goal completion or submit actions', async () => {
  const store = await pendingStore(); const state = store.load();
  state.goal!.status = 'paused'; state.sequence++; store.save(state);
  const h = harness(role => { assert.equal(role, 'route'); return { kind: 'respond', text: '已经完成。' }; }, { store });
  await h.message('你只拿到了手上'); await h.loop.whenIdle();
  assert.equal(h.sent.includes('已经完成。'), true); assert.deepEqual(h.calls, ['decision']);
  assert.equal(h.loop.snapshot.goal?.status, 'paused'); assert.equal(h.operations.length, 0); h.loop.stop();
});

test('V2 journal survives incomplete tail, detects corruption and prevents concurrent ownership', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-v2-store-')), file = join(dir, 'agent.jsonl');
  try {
    const one = new FileAgentStore(file), state = emptyAgentState(); state.sequence = 1; one.save(state);
    assert.throws(() => new FileAgentStore(file), /IN_USE/); one.close();
    appendFileSync(file, '{incomplete');
    const two = new FileAgentStore(file); assert.equal(two.load().sequence, 1); two.close();
    assert.equal(readFileSync(file, 'utf8').endsWith('\n'), true);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"previous":""', '"previous":"tampered"'));
    assert.throws(() => new FileAgentStore(file), /CORRUPT/);
  } finally { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); }
});

test('V2 durable checkpoints preserve chain and load only current journal after rotation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-v2-checkpoint-')), file = join(dir, 'agent.jsonl');
  try {
    const store = new FileAgentStore(file), state = emptyAgentState();
    for (let i = 1; i <= 65; i++) { state.sequence = i; store.save(state); }
    store.close();
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
    assert.ok(readFileSync(`${file}.64.archive`, 'utf8').length > 0);
    const recovered = new FileAgentStore(file); assert.equal(recovered.load().sequence, 65); recovered.close();
  } finally { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); }
});

test('V2 chat while waiting does not lose wakeup or remaining goal', async () => {
  let waits = 0;
  const h = harness((role, p) => {
    if (role === 'route') return p.message.text === '进度？' ? { kind: 'respond', text: '正在等待世界更新。' } : route();
    if (role === 'director') return waits++ === 0 ? { kind: 'wait', reason: '等待加工', milliseconds: 100 } : { kind: 'assess' };
    return assess(p);
  });
  await h.message('任务'); await h.loop.whenIdle();
  assert.equal(h.loop.snapshot.goal?.status, 'waiting_world');
  await h.message('进度？'); await h.loop.whenIdle();
  await new Promise(resolve => setTimeout(resolve, 130)); await h.loop.whenIdle();
  assert.equal(h.loop.snapshot.goal?.status, 'completed');
  assert.equal(h.loop.snapshot.goal?.originalRequest, '任务'); h.loop.stop();
});

test('V2 clarification preserves the original request alongside the answer', async () => {
  const h = harness((role, p) => {
    if (role === 'route') return p.message.text === '把东西放箱子' ? { kind: 'ask', question: '哪个箱子？', reason: '多个箱子都可能是目标' } : route('存进右边箱子');
    return { kind: 'blocked', reason: '测试保存目标' };
  });
  await h.message('把东西放箱子'); await h.loop.whenIdle(); await h.message('右边'); await h.loop.whenIdle();
  assert.equal(h.loop.snapshot.goal?.originalRequest, '把东西放箱子');
  assert.deepEqual(h.loop.snapshot.goal?.messages.map(m => m.text), ['把东西放箱子', '右边']); h.loop.stop();
});

test('V2 amendments invalidate an executing old batch and keep pending effects for reconciliation', async () => {
  let release!: () => void;
  const h = harness((role, p) => {
    if (role === 'route') return p.message.text === '改为拿着' ? { ...route('拿在手上'), mode: 'amend' } : route();
    if (role === 'director') return p.goal.revision > 1 ? { kind: 'blocked', reason: '等候核对旧操作' } : advance('穿戴');
    return propose({ type: 'equip', item: 'diamond_chestplate', destination: 'torso' }, { type: 'unequip', destination: 'torso' });
  });
  h.setNative(() => new Promise<void>(resolve => { release = resolve; }));
  await h.message('穿上胸甲'); await until(() => !!release); await h.message('改为拿着');
  assert.equal(h.loop.snapshot.goal?.revision, 2); assert.equal(h.operations.length, 1);
  release(); await h.loop.whenIdle(); assert.equal(h.operations.length, 1);
  assert.ok(h.loop.snapshot.goal?.pendingBatch); assert.equal(h.loop.snapshot.goal?.originalRequest, '穿上胸甲'); h.loop.stop();
});

test('V2 validates every original criterion before accepting a completion report', async () => {
  let done = false;
  const h = harness((role, p) => {
    if (role === 'route') return route();
    if (role === 'director') return done ? { kind: 'blocked', reason: '还有遗漏' } : { kind: 'assess' };
    const result = assess(p); result.verdicts.pop(); done = true; return result;
  });
  await h.message('过来再穿戴'); await h.loop.whenIdle();
  assert.equal(h.loop.snapshot.goal?.status, 'paused'); assert.equal(h.sent.includes('完整目标已完成。'), false); h.loop.stop();
});

test('registered local positions are bounded, rechecked and never accepted as block targets', () => {
  const { actions, bot } = fixture('1.21.1');
  bot.blockAt = (p: Vec3) => ({ name: 'air', stateId: 0, position: p });
  const query = actions.query({ type: 'register_position', position: { x: 3, y: 0, z: 0 } });
  assert.equal(query.status, 'succeeded'); const ref = (query.data as any).target.ref;
  assert.equal(actions.observations.targets.resolve(ref, ['position']).position.x, 3);
  assert.throws(() => actions.observations.targets.resolve(ref, ['block']), /种类/);
  assert.notEqual(actions.query({ type: 'register_position', position: { x: 100, y: 0, z: 0 } }).status, 'succeeded');
  actions.dispose();
});

test('model operations require intent-bearing choices while native compatibility stays isolated', () => {
  for (const op of [{ type: 'equip', item: 'diamond_chestplate' }, { type: 'navigate', targetRef: randomUUID() },
    { type: 'use_item', durationMs: 1 }, { type: 'place', targetRef: randomUUID(), item: 'stone' }]) {
    assert.equal(basicOperationSchema.safeParse(op).success, false);
  }
});

test('observations expose decoded item drops and held equipment, with unknown metadata kept unknown', () => {
  const { bot, actions } = fixture('1.21.1');
  bot.heldItem = { name: 'diamond_chestplate', count: 1 };
  bot.entities[7] = { id: 7, name: 'item', position: new Vec3(1, 0, 0), getDroppedItem: () => ({ name: 'spruce_log', count: 2 }) };
  bot.entities[8] = { id: 8, name: 'item', position: new Vec3(2, 0, 0), getDroppedItem: () => { throw new Error('unknown'); } };
  const snapshot = actions.query({ type: 'snapshot' }).data as any;
  assert.equal(snapshot.heldItem.name, 'diamond_chestplate');
  assert.deepEqual(snapshot.entities.find((e: any) => e.id === 7).droppedItem, { known: true, name: 'spruce_log', count: 2 });
  assert.deepEqual(snapshot.entities.find((e: any) => e.id === 8).droppedItem, { known: false });
  const targets = actions.query({ type: 'observe_targets', entities: true }).data as any;
  assert.equal(targets.targets[0].droppedItem.name, 'spruce_log'); actions.dispose();
});

test('V2 runtime uses an empty skill registry and cannot fall back to legacy skills', async () => {
  const { bot, actions } = fixture('1.21.1'); actions.dispose(); bot.chat = () => {}; bot.whisper = () => {};
  const runtime = new CompanionRuntime(bot, { agentMode: 'v2', owners: ['alice'], agent: { approvedPromptHash: brainPromptManifest().hash }, llm: { complete: async () => JSON.stringify({ kind: 'skill', skill: 'gather_wood', params: {} }) } });
  assert.ok(runtime.interaction instanceof AgentLoop); assert.equal(runtime.controller.skills.list().length, 0);
  await runtime.interaction.handle({ id: 'v2', player: 'alice', text: '捡木头', receivedAt: Date.now() });
  await runtime.interaction.whenIdle(); assert.equal(runtime.scheduler.list().length, 0); runtime.stop();
});
