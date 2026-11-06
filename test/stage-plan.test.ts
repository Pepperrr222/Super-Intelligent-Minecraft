import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stagePlanSchema,runStage,type StageState,type StagePort} from '../src/stage-plan.js';
const done={id:'done',kind:'end',outcome:'stage_complete',reason:'阶段结束'};
function state(nodes:unknown[],extra:Record<string,unknown>={}):StageState {
  const plan=stagePlanSchema.parse({purpose:'通用阶段',entry:(nodes[0] as any).id,maxOperations:64,maxDurationMs:60000,nodes,...extra});
  return {id:randomUUID(),revision:1,plan,cursor:plan.entry,status:'running',deadline:Date.now()+60000,transitions:0,operations:0,outputs:{},counts:{},frames:{}};
}
const port=(extra:Partial<StagePort>={}):StagePort=>({check(){},save(){},query(){return {status:'succeeded',data:{}};},async act(){return {status:'succeeded',data:{}};},...extra});

test('one stage traverses twelve observed targets without model turns or batch-of-four breaks',async()=>{
  const refs=Array.from({length:12},()=>({ref:randomUUID()}));const written:string[]=[];
  const s=state([
    {id:'scan',kind:'query',query:{type:'observe_targets',params:{names:['stone'],radius:4,limit:16}},bindings:[],next:'each'},
    {id:'each',kind:'foreach',from:{node:'scan',path:['targets']},limit:12,body:'dig',next:'done'},
    {id:'dig',kind:'act',operation:{type:'dig',params:{}},bindings:[{parameter:['targetRef'],from:{node:'each',path:['ref']}}],next:'each'},done]);
  await runStage(s,port({query:()=>({status:'succeeded',data:{targets:refs}}),act:async op=>{written.push((op as any).targetRef);return {status:'succeeded'};}}));
  assert.deepEqual(written,refs.map(r=>r.ref));assert.equal(s.status,'stage_complete');assert.equal(s.operations,12);
});
test('previously observed explicit targets can be bound through a literal node without implicit input variables',async()=>{
  const ref=randomUUID();const s=state([
    {id:'targets',kind:'value',value:[{ref}],next:'each'},
    {id:'each',kind:'foreach',from:{node:'targets',path:[]},limit:1,body:'dig',next:'done'},
    {id:'dig',kind:'act',operation:{type:'dig',params:{}},bindings:[{parameter:['targetRef'],from:{node:'each',path:['ref']}}],next:'each'},done]);
  await runStage(s,port({act:async op=>{assert.equal((op as any).targetRef,ref);return {status:'succeeded'};}}));
  assert.equal(s.operations,1);assert.equal(s.status,'stage_complete');
});
test('placement, fresh observation, bound workstation craft and event wait run in sequence',async()=>{
  const support=randomUUID(),table=randomUUID(),recipe='a'.repeat(64),ops:any[]=[];
  const s=state([
    {id:'equip',kind:'act',operation:{type:'equip',params:{item:'crafting_table',destination:'hand'}},bindings:[],next:'place'},
    {id:'place',kind:'act',operation:{type:'place',params:{item:'crafting_table',targetRef:support,face:'up'}},bindings:[],next:'scan'},
    {id:'scan',kind:'query',query:{type:'observe_targets',params:{names:['crafting_table'],radius:4,limit:1}},bindings:[],next:'craft'},
    {id:'craft',kind:'act',operation:{type:'craft',params:{item:'stone_pickaxe',count:1,recipeRef:recipe}},bindings:[{parameter:['tableRef'],from:{node:'scan',path:['targets',0,'ref']}}],next:'wait'},
    {id:'wait',kind:'act',operation:{type:'wait_until',params:{condition:{kind:'inventory_at_least',item:'stone_pickaxe',count:1}}},bindings:[],next:'done'},done]);
  await runStage(s,port({query:()=>({status:'succeeded',data:{targets:[{ref:table}]}}),act:async op=>{ops.push(op);return {status:'succeeded'};}}));
  assert.deepEqual(ops.map(o=>o.type),['equip','place','craft','wait_until']);assert.equal(ops[2].tableRef,table);
});
test('branch and bounded repeat can move inventory until a fresh count meets a model-selected threshold',async()=>{
  const targetRef=randomUUID();let stock=0;
  const s=state([
    {id:'repeat',kind:'repeat',maxIterations:12,body:'check',next:'limit'},
    {id:'check',kind:'query',query:{type:'verify',params:{condition:{kind:'inventory_at_least',item:'oak_log',count:3}}},bindings:[],next:'branch'},
    {id:'branch',kind:'branch',test:{from:{node:'check',path:['value']},compare:'eq',value:true},yes:'done',no:'take'},
    {id:'take',kind:'act',operation:{type:'container_transfer',params:{targetRef,direction:'withdraw',item:'oak_log',count:1}},bindings:[],next:'repeat'},
    {id:'limit',kind:'end',outcome:'needs_decision',reason:'达到循环上限，需要重新判断'},done]);
  await runStage(s,port({query:()=>({status:'succeeded',data:{value:stock>=3}}),act:async()=>{stock++;return {status:'succeeded'};}}));
  assert.equal(stock,3);assert.equal(s.status,'stage_complete');
});
test('partial failure preserves pending node and does not execute or retry its successor',async()=>{
  let writes=0;const s=state([{id:'take',kind:'act',operation:{type:'toss',params:{item:'stone',count:1}},bindings:[],next:'done'},done]);
  await assert.rejects(runStage(s,port({act:async()=>{writes++;return {status:'failed',error:'partially transferred'};}})),/NODE_FAILED/);
  assert.equal(writes,1);assert.equal(s.pendingNode,'take');assert.equal(s.cursor,'take');assert.equal(s.status,'interrupted');
  await assert.rejects(runStage(s,port({act:async()=>{throw new Error('must not replay');}})),/RECOVERY_REQUIRED/);
});
test('cancellation while native work is in flight does not advance cursor or start another action',async()=>{
  let cancelled=false,release!:()=>void,writes=0;
  const s=state([{id:'loop',kind:'repeat',maxIterations:10,body:'act',next:'done'},
    {id:'act',kind:'act',operation:{type:'wait',params:{durationMs:1}},bindings:[],next:'loop'},done]);
  const work=runStage(s,port({check(){if(cancelled)throw new Error('cancelled');},act:async()=>{writes++;await new Promise<void>(r=>release=r);return {status:'succeeded'};}}));
  while(!release)await new Promise<void>(r=>setImmediate(r));cancelled=true;release();
  await assert.rejects(work,/cancelled/);assert.equal(writes,1);assert.equal(s.pendingNode,'act');
});
test('unknown guard and missing binding do not produce side effects',async()=>{
  let writes=0;const s=state([{id:'act',kind:'act',operation:{type:'dig',params:{targetRef:randomUUID()}},bindings:[],next:'done'},done],
    {guards:[{kind:'health_at_least',health:8}]});
  await assert.rejects(runStage(s,port({query:()=>({status:'succeeded',data:{value:'unknown'}}),act:async()=>{writes++;return {status:'succeeded'};}})),/GUARD/);
  assert.equal(writes,0);
  assert.throws(()=>state([{id:'act',kind:'act',operation:{type:'dig',params:{}},bindings:[{parameter:['targetRef'],from:{node:'act',path:['ref']}}],next:'done'},done]),/尚未/);assert.equal(writes,0);
});
test('all graph cycles obey transition, operation and wall time limits',async()=>{
  const s=state([{id:'act',kind:'act',operation:{type:'wait',params:{durationMs:1}},bindings:[],next:'act'}],{maxOperations:3});
  await assert.rejects(runStage(s,port()),/OPERATION_LIMIT/);assert.equal(s.operations,3);
  const q=state([{id:'q',kind:'query',query:{type:'snapshot',params:{}},bindings:[],next:'q'}]);
  await assert.rejects(runStage(q,port()),/TRANSITION_LIMIT/);assert.equal(q.operations,0);
  const expired=state([done]);await assert.rejects(runStage(expired,port({now:()=>expired.deadline})),/TIME_LIMIT/);
});
test('checkpoint failure before submission, invalid graphs and prototype paths cannot execute',async()=>{
  const s=state([{id:'act',kind:'act',operation:{type:'wait',params:{durationMs:1}},bindings:[],next:'done'},done]);
  await assert.rejects(runStage(s,port({save(){throw new Error('disk failed');},act:async()=>assert.fail('must not run')})),/disk failed/);
  assert.throws(()=>state([{...done,id:'oops'}],{entry:'missing'}));
  assert.throws(()=>state([{id:'act',kind:'act',operation:{type:'dig',params:{}},bindings:[{parameter:['__proto__','x'],from:{node:'act',path:[]}}],next:'done'},done]));
  assert.throws(()=>state([{id:'say',kind:'act',operation:{type:'say',params:{message:'完成'}},bindings:[],next:'done'},done]));
});
